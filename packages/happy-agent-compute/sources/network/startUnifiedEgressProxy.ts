import { randomBytes, timingSafeEqual } from "node:crypto";
import { connect, type Socket } from "node:net";

import {
    createBoundedEgressResolver,
    egressResolutionBlockedReason,
    resolveAnyEgressAddress,
    resolvePublicEgressAddress,
} from "./impl/resolveEgressAddress.js";
import {
    egressBlockReason,
    normalizeEgressDomain,
    validateEgressRules,
} from "./impl/egressPolicyRules.js";
import {
    EGRESS_LINK_HANDSHAKE_ACCEPTED,
    EGRESS_LINK_HANDSHAKE_REFUSED,
    EGRESS_LINK_INITIAL_WINDOW_BYTES,
    EGRESS_LINK_MAX_CHUNK_BYTES,
    EGRESS_LINK_MAX_STREAMS,
    EgressLinkReader,
    decodeEgressLinkOpenRequest,
    egressLinkFrame,
    egressLinkRefusal,
    encodeEgressLinkFrame,
    encodeEgressLinkHandshakeReply,
    encodeEgressLinkRefusal,
} from "./impl/egressLinkFrames.js";
import {
    parseUnifiedEgressCommandPolicy,
    parseUnifiedEgressDestination,
    type UnifiedEgressCommand,
    type UnifiedEgressCommandPolicy,
    type UnifiedEgressDenial,
    type UnifiedEgressProxy,
} from "./UnifiedEgressProxy.js";

const DEFAULT_DNS_RESOLUTION_TIMEOUT_MS = 2_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const TOKEN_BYTES = 32;

type AttachedLink = NodeJS.ReadWriteStream & { destroy(): void };

interface UnifiedEgressProxyOptions {
    connectUpstream?: (options: { host: string; port: number }) => Socket;
    handshakeTimeoutMs?: number;
    resolveAddress?: (host: string) => Promise<string>;
    resolveTimeoutMs?: number;
    /**
     * Terminates TLS for commands that ask for it. Absent means no command may ask: the proxy
     * refuses such a registration rather than tunnelling opaquely while the caller believes
     * requests are being inspected.
     */
    terminateTls?: (stream: Socket, host: string) => Socket;
}

interface Registration {
    denial: UnifiedEgressDenial | undefined;
    listeners: Set<(denial: UnifiedEgressDenial) => void>;
    links: Set<AttachedLink>;
    policy: UnifiedEgressCommandPolicy;
    revoked: boolean;
}

/**
 * One long-lived proxy shared by every command.
 *
 * It authenticates a token, resolves it to that command's policy, and applies that policy per
 * connection. Nothing about a command's reach is ambient: an unauthenticated link is answered with
 * a refusal and dropped, and a revoked registration takes its live links down with it.
 */
export function startUnifiedEgressProxy(
    options: UnifiedEgressProxyOptions = {},
): UnifiedEgressProxy {
    const resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_DNS_RESOLUTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(resolveTimeoutMs) || resolveTimeoutMs < 1) {
        throw new Error("Unified egress DNS resolution timeout must be a positive integer.");
    }
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1) {
        throw new Error("Unified egress handshake timeout must be a positive integer.");
    }
    const connectUpstream = options.connectUpstream ?? ((target) => connect(target));
    const registrations = new Map<string, Registration>();
    const links = new Set<AttachedLink>();
    let closed = false;

    const recordDenial = (registration: Registration, denial: UnifiedEgressDenial) => {
        if (registration.denial !== undefined) return;
        registration.denial = denial;
        for (const listener of registration.listeners) {
            try {
                listener(denial);
            } catch {
                // The refusal the sandbox receives must not depend on an optional observer.
            }
        }
    };

    return {
        registerCommand(policy) {
            if (closed) throw new Error("The unified egress proxy is closed.");
            const parsed = parseUnifiedEgressCommandPolicy(policy);
            validateEgressRules(parsed);
            if (parsed.tlsTermination === true && options.terminateTls === undefined) {
                throw new Error(
                    "This command asked for TLS termination, but no certificate authority is configured to terminate it. Interception must be explicit, so the command is refused rather than tunnelled without inspection.",
                );
            }
            const token = randomBytes(TOKEN_BYTES).toString("hex");
            const registration: Registration = {
                denial: undefined,
                listeners: new Set(),
                links: new Set(),
                policy: parsed,
                revoked: false,
            };
            registrations.set(token, registration);
            return {
                token,
                denial: () => registration.denial,
                onDenial(listener) {
                    registration.listeners.add(listener);
                    if (registration.denial !== undefined) {
                        try {
                            listener(registration.denial);
                        } catch {
                            // The recorded denial stays authoritative even if an observer throws.
                        }
                    }
                    return () => registration.listeners.delete(listener);
                },
                revoke() {
                    if (registration.revoked) return;
                    registration.revoked = true;
                    registrations.delete(token);
                    registration.listeners.clear();
                    for (const link of registration.links) link.destroy();
                    registration.links.clear();
                },
            } satisfies UnifiedEgressCommand;
        },

        attach(link) {
            links.add(link);
            const dropLink = () => {
                links.delete(link);
                link.destroy();
            };
            if (closed) {
                dropLink();
                return;
            }
            serveLink({
                connectUpstream,
                handshakeTimeoutMs,
                link,
                onFinished: () => links.delete(link),
                recordDenial,
                registrations,
                resolveTimeoutMs,
                ...(options.resolveAddress === undefined
                    ? {}
                    : { resolveAddress: options.resolveAddress }),
                ...(options.terminateTls === undefined
                    ? {}
                    : { terminateTls: options.terminateTls }),
            });
        },

        async close() {
            if (closed) return;
            closed = true;
            for (const registration of registrations.values()) {
                registration.listeners.clear();
                registration.links.clear();
            }
            registrations.clear();
            for (const link of links) link.destroy();
            links.clear();
        },
    };
}

interface LinkContext {
    connectUpstream: (options: { host: string; port: number }) => Socket;
    handshakeTimeoutMs: number;
    link: AttachedLink;
    onFinished: () => void;
    recordDenial: (registration: Registration, denial: UnifiedEgressDenial) => void;
    registrations: Map<string, Registration>;
    resolveAddress?: (host: string) => Promise<string>;
    resolveTimeoutMs: number;
    terminateTls?: (stream: Socket, host: string) => Socket;
}

interface LinkStream {
    /** Bytes this side may still send before the sandbox grants more credit. */
    credit: number;
    ended: boolean;
    pending: Buffer[];
    socket: Socket;
}

function serveLink(context: LinkContext): void {
    const { link } = context;
    const reader = new EgressLinkReader();
    const streams = new Map<number, LinkStream>();
    let registration: Registration | undefined;
    let authenticated = false;
    let finished = false;

    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(handshakeTimer);
        for (const stream of streams.values()) stream.socket.destroy();
        streams.clear();
        registration?.links.delete(link);
        context.onFinished();
        link.destroy();
    };
    const handshakeTimer = setTimeout(finish, context.handshakeTimeoutMs);
    handshakeTimer.unref();

    const write = (frame: Buffer) => {
        if (!finished) link.write(frame);
    };
    const refuse = (streamId: number, reason: number, message: string) => {
        write(
            encodeEgressLinkFrame(
                egressLinkFrame.refused,
                streamId,
                encodeEgressLinkRefusal(reason, message),
            ),
        );
    };

    link.on("error", finish);
    link.on("close", finish);
    link.on("end", finish);
    link.on("data", (chunk: Buffer | string) => {
        if (finished) return;
        reader.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        try {
            if (!authenticated) {
                const token = reader.takeHandshakeToken();
                if (token === undefined) return;
                registration = authenticate(context.registrations, token);
                if (registration === undefined) {
                    // A token that does not authenticate gets nothing: the refusal is the whole
                    // answer, and the supervisor turns it into "this command has no network".
                    link.write(encodeEgressLinkHandshakeReply(EGRESS_LINK_HANDSHAKE_REFUSED));
                    finish();
                    return;
                }
                authenticated = true;
                clearTimeout(handshakeTimer);
                registration.links.add(link);
                link.write(encodeEgressLinkHandshakeReply(EGRESS_LINK_HANDSHAKE_ACCEPTED));
            }
            let frame = reader.takeFrame();
            while (frame !== undefined) {
                handleFrame(frame);
                if (finished) return;
                frame = reader.takeFrame();
            }
        } catch {
            // A protocol violation on a trusted link cannot be resynchronised from, and guessing
            // would be worse than refusing.
            finish();
        }
    });

    function handleFrame(frame: { kind: number; payload: Buffer; streamId: number }): void {
        const stream = streams.get(frame.streamId);
        switch (frame.kind) {
            case egressLinkFrame.open:
                void openStream(frame.streamId, frame.payload);
                return;
            case egressLinkFrame.data:
                if (stream === undefined) return;
                stream.socket.write(frame.payload, () => {
                    // Credit is returned only once the bytes have left for the destination, which
                    // is what bounds how much this process holds for one stream.
                    write(
                        encodeEgressLinkFrame(
                            egressLinkFrame.window,
                            frame.streamId,
                            windowPayload(frame.payload.length),
                        ),
                    );
                });
                return;
            case egressLinkFrame.end:
                stream?.socket.end();
                return;
            case egressLinkFrame.reset:
                if (stream !== undefined) {
                    streams.delete(frame.streamId);
                    stream.socket.destroy();
                }
                return;
            case egressLinkFrame.window:
                if (stream === undefined || frame.payload.length < 4) return;
                stream.credit += frame.payload.readUInt32BE(0);
                flushStream(frame.streamId, stream);
                return;
            default:
                finish();
        }
    }

    async function openStream(streamId: number, payload: Buffer): Promise<void> {
        const current = registration;
        if (current === undefined) {
            finish();
            return;
        }
        if (streams.size >= EGRESS_LINK_MAX_STREAMS) {
            refuse(
                streamId,
                egressLinkRefusal.unreachable,
                "This command already has the maximum number of open connections.",
            );
            return;
        }
        const destination = parseUnifiedEgressDestination(decodeEgressLinkOpenRequest(payload));
        if (destination === undefined) {
            refuse(
                streamId,
                egressLinkRefusal.blocked,
                "The requested destination could not be understood.",
            );
            return;
        }
        const host = normalizeEgressDomain(destination.host);
        const blocked = egressBlockReason(current.policy, host, destination.port);
        if (blocked !== undefined) {
            context.recordDenial(current, { host, port: destination.port, reason: blocked });
            refuse(
                streamId,
                egressLinkRefusal.blocked,
                blocked === "denied"
                    ? "This destination is denied by the sandbox policy."
                    : "This destination is not in the sandbox allow list.",
            );
            return;
        }

        const resolve = createBoundedEgressResolver(
            context.resolveAddress ??
                (current.policy.allowPrivateAddresses === true
                    ? resolveAnyEgressAddress
                    : resolvePublicEgressAddress),
            context.resolveTimeoutMs,
        );
        let address: string;
        try {
            address = await resolve(host);
        } catch (error) {
            const reason = egressResolutionBlockedReason(error) ?? "dns_resolution_failed";
            context.recordDenial(current, { host, port: destination.port, reason });
            refuse(
                streamId,
                egressLinkRefusal.unresolvable,
                reason === "non_public_address"
                    ? "The sandbox policy blocks local and private network addresses."
                    : "The destination name could not be resolved within the policy timeout.",
            );
            return;
        }
        if (finished || current.revoked) {
            refuse(streamId, egressLinkRefusal.unreachable, "The sandbox link is closing.");
            return;
        }

        const socket = context.connectUpstream({ host: address, port: destination.port });
        const stream: LinkStream = {
            credit: EGRESS_LINK_INITIAL_WINDOW_BYTES,
            ended: false,
            pending: [],
            socket,
        };
        streams.set(streamId, stream);
        socket.on("error", () => {
            if (streams.delete(streamId)) {
                context.recordDenial(current, {
                    host,
                    port: destination.port,
                    reason: "connection_failed",
                });
                refuse(
                    streamId,
                    egressLinkRefusal.unreachable,
                    "The destination could not be reached.",
                );
                write(encodeEgressLinkFrame(egressLinkFrame.reset, streamId, Buffer.alloc(0)));
            }
            socket.destroy();
        });
        socket.once("connect", () => {
            write(encodeEgressLinkFrame(egressLinkFrame.opened, streamId, Buffer.alloc(0)));
            socket.on("data", (chunk: Buffer) => {
                stream.pending.push(chunk);
                flushStream(streamId, stream);
            });
            socket.once("end", () => {
                stream.ended = true;
                flushStream(streamId, stream);
            });
            socket.once("close", () => {
                if (streams.get(streamId) === stream && stream.pending.length === 0) {
                    streams.delete(streamId);
                }
            });
        });
    }

    /** Sends as much of a stream's backlog as the sandbox has granted credit for. */
    function flushStream(streamId: number, stream: LinkStream): void {
        while (stream.pending.length > 0 && stream.credit > 0) {
            const next = stream.pending[0]!;
            const size = Math.min(next.length, stream.credit, EGRESS_LINK_MAX_CHUNK_BYTES);
            const chunk = next.subarray(0, size);
            if (size === next.length) stream.pending.shift();
            else stream.pending[0] = next.subarray(size);
            stream.credit -= size;
            write(encodeEgressLinkFrame(egressLinkFrame.data, streamId, chunk));
        }
        // Reading further would only grow a backlog this process would have to hold, so the
        // destination is paused until the sandbox drains what it already has.
        if (stream.pending.length > 0) stream.socket.pause();
        else stream.socket.resume();
        if (stream.pending.length === 0 && stream.ended) {
            write(encodeEgressLinkFrame(egressLinkFrame.end, streamId, Buffer.alloc(0)));
            stream.ended = false;
        }
    }
}

function windowPayload(bytes: number): Buffer {
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt32BE(bytes, 0);
    return payload;
}

/**
 * Resolves a token to one command's registration in constant time.
 *
 * The comparison is length-padded rather than short-circuiting, because the token is the only
 * thing standing between one command's link and another command's reach.
 */
function authenticate(
    registrations: Map<string, Registration>,
    token: string,
): Registration | undefined {
    const presented = Buffer.from(token, "utf8");
    let matched: Registration | undefined;
    for (const [candidate, registration] of registrations) {
        const expected = Buffer.from(candidate, "utf8");
        if (expected.length !== presented.length) continue;
        if (timingSafeEqual(expected, presented)) matched = registration;
    }
    return matched?.revoked === true ? undefined : matched;
}
