import { createServer, connect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
    EGRESS_LINK_INITIAL_WINDOW_BYTES,
    EGRESS_LINK_MAGIC,
    EgressLinkReader,
    egressLinkFrame,
    encodeEgressLinkFrame,
} from "../../sources/network/impl/egressLinkFrames.js";
import { startUnifiedEgressProxy } from "../../sources/network/startUnifiedEgressProxy.js";
import type {
    UnifiedEgressDenial,
    UnifiedEgressProxy,
} from "../../sources/network/UnifiedEgressProxy.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("startUnifiedEgressProxy", () => {
    it("carries an allowed destination and reports the bytes the origin sent back", async () => {
        const origin = await startEchoOrigin();
        const { proxy, command } = startProxyForCommand({
            allowedDomains: [{ domain: "allowed.test" }],
        });
        const client = await attachClient(proxy, command.token);

        const opened = await client.open("allowed.test", origin.port);
        expect(opened).toEqual({ status: "opened" });
        await client.send(1, Buffer.from("hello-origin"));
        client.end(1);

        expect((await client.receiveAll(1)).toString()).toBe("hello-origin");
        expect(command.denial()).toBeUndefined();
    });

    it("refuses a destination the command's policy does not allow", async () => {
        const origin = await startEchoOrigin();
        const denials: UnifiedEgressDenial[] = [];
        const { proxy, command } = startProxyForCommand({
            allowedDomains: [{ domain: "allowed.test" }],
        });
        command.onDenial((denial) => denials.push(denial));
        const client = await attachClient(proxy, command.token);

        expect(await client.open("blocked.test", origin.port)).toEqual({
            status: "refused",
            reason: 1,
            message: "This destination is not in the sandbox allow list.",
        });
        expect(denials).toEqual([
            { host: "blocked.test", port: origin.port, reason: "not_allowed" },
        ]);
    });

    it("refuses a denied destination even when an allow rule would match it", async () => {
        const origin = await startEchoOrigin();
        const { proxy, command } = startProxyForCommand({
            allowedDomains: [{ domain: "*" }],
            deniedDomains: [{ domain: "internal.test" }],
        });
        const client = await attachClient(proxy, command.token);

        const refusal = await client.open("internal.test", origin.port);
        expect(refusal).toMatchObject({ status: "refused", reason: 1 });
        expect(command.denial()).toEqual({
            host: "internal.test",
            port: origin.port,
            reason: "denied",
        });
    });

    it("gives an unauthenticated link nothing at all", async () => {
        const { proxy } = startProxyForCommand({ allowedDomains: [{ domain: "allowed.test" }] });
        const client = await attachClient(proxy, "0".repeat(64), { expectRefusal: true });

        expect(await client.handshakeStatus).toBe(1);
        expect(await client.closed).toBe(true);
    });

    it("keeps one command's reach out of another command's token", async () => {
        const origin = await startEchoOrigin();
        const proxy = startProxy();
        const permissive = proxy.registerCommand({ allowedDomains: [{ domain: "allowed.test" }] });
        const restricted = proxy.registerCommand({ allowedDomains: [{ domain: "other.test" }] });
        const client = await attachClient(proxy, restricted.token);

        expect(await client.open("allowed.test", origin.port)).toMatchObject({
            status: "refused",
            reason: 1,
        });
        expect(permissive.denial()).toBeUndefined();
        expect(restricted.denial()).toEqual({
            host: "allowed.test",
            port: origin.port,
            reason: "not_allowed",
        });
    });

    it("drops the live link of a command whose registration is revoked", async () => {
        const { proxy, command } = startProxyForCommand({
            allowedDomains: [{ domain: "allowed.test" }],
        });
        const client = await attachClient(proxy, command.token);
        expect(await client.handshakeStatus).toBe(0);

        command.revoke();
        expect(await client.closed).toBe(true);
    });

    it("blocks a private address that the allow list would otherwise permit", async () => {
        const { proxy, command } = startProxyForCommand(
            { allowedDomains: [{ domain: "localhost" }] },
            { resolveAddress: undefined },
        );
        const client = await attachClient(proxy, command.token);

        expect(await client.open("localhost", 80)).toMatchObject({ status: "refused", reason: 2 });
        expect(command.denial()).toEqual({
            host: "localhost",
            port: 80,
            reason: "non_public_address",
        });
    });

    it("reports a destination that cannot be reached rather than reporting a policy block", async () => {
        const closedPort = await findClosedPort();
        const { proxy, command } = startProxyForCommand({
            allowedDomains: [{ domain: "allowed.test" }],
        });
        const client = await attachClient(proxy, command.token);

        expect(await client.open("allowed.test", closedPort)).toMatchObject({
            status: "refused",
            reason: 3,
        });
        expect(command.denial()).toEqual({
            host: "allowed.test",
            port: closedPort,
            reason: "connection_failed",
        });
    });

    it("carries a transfer larger than one credit window in both directions", async () => {
        const origin = await startEchoOrigin();
        const { proxy, command } = startProxyForCommand({
            allowedDomains: [{ domain: "allowed.test" }],
        });
        const client = await attachClient(proxy, command.token);
        expect(await client.open("allowed.test", origin.port)).toEqual({ status: "opened" });

        const payload = Buffer.alloc(EGRESS_LINK_INITIAL_WINDOW_BYTES * 3, "x");
        const received = client.receiveAll(1);
        await client.send(1, payload);
        client.end(1);

        expect((await received).length).toBe(payload.length);
    });

    it("refuses to register a command that asks for TLS termination with nothing to terminate it", () => {
        const proxy = startProxy();
        expect(() =>
            proxy.registerCommand({
                allowedDomains: [{ domain: "allowed.test" }],
                tlsTermination: true,
            }),
        ).toThrow(/no certificate authority is configured/u);
    });

    it("refuses a policy it cannot evaluate", () => {
        const proxy = startProxy();
        expect(() => proxy.registerCommand({ allowedDomains: [{ domain: "" }] })).toThrow(
            /Invalid unified egress command policy/u,
        );
        expect(() =>
            proxy.registerCommand({ allowedDomains: [{ domain: "a.*.example.com" }] }),
        ).toThrow(/Invalid managed network domain pattern/u);
    });
});

// -------------------------------------------------------------------------------------------
// Harness
// -------------------------------------------------------------------------------------------

function startProxy(options: { resolveAddress?: (host: string) => Promise<string> } = {}) {
    const proxy = startUnifiedEgressProxy({
        resolveAddress: options.resolveAddress ?? (async () => "127.0.0.1"),
    });
    cleanups.push(() => proxy.close());
    return proxy;
}

function startProxyForCommand(
    policy: Parameters<UnifiedEgressProxy["registerCommand"]>[0],
    options: { resolveAddress?: ((host: string) => Promise<string>) | undefined } = {},
) {
    const proxy =
        "resolveAddress" in options && options.resolveAddress === undefined
            ? startProxyWithRealResolution()
            : startProxy();
    return { proxy, command: proxy.registerCommand(policy) };
}

function startProxyWithRealResolution() {
    const proxy = startUnifiedEgressProxy({});
    cleanups.push(() => proxy.close());
    return proxy;
}

async function startEchoOrigin(): Promise<{ port: number }> {
    const server = createServer((socket) => {
        socket.on("error", () => {});
        socket.pipe(socket);
    });
    const port = await listen(server);
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port };
}

async function findClosedPort(): Promise<number> {
    const server = createServer();
    const port = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return address.port;
}

interface ClientStream {
    chunks: Buffer[];
    credit: number;
    ended: boolean;
    onCredit: (() => void)[];
    onData: (() => void)[];
}

/**
 * The supervisor's side of the link, written independently of the Rust implementation so the
 * proxy is exercised through the wire protocol rather than through a shared object.
 */
class LinkClient {
    readonly closed: Promise<boolean>;
    readonly handshakeStatus: Promise<number>;
    #nextStreamId = 1;
    #reader = new EgressLinkReader();
    #socket: Socket;
    #streams = new Map<number, ClientStream>();
    #opens = new Map<number, (result: OpenResult) => void>();
    #resolveHandshake: (status: number) => void = () => {};
    #resolveClosed: (closed: boolean) => void = () => {};
    #authenticated = false;

    constructor(socket: Socket, token: string) {
        this.#socket = socket;
        this.handshakeStatus = new Promise((resolve) => (this.#resolveHandshake = resolve));
        this.closed = new Promise((resolve) => (this.#resolveClosed = resolve));
        socket.on("error", () => this.#resolveClosed(true));
        socket.on("close", () => this.#resolveClosed(true));
        socket.on("data", (chunk) => this.#consume(chunk));
        const tokenBytes = Buffer.from(token, "utf8");
        const hello = Buffer.allocUnsafe(EGRESS_LINK_MAGIC.length + 2 + tokenBytes.length);
        hello.write(EGRESS_LINK_MAGIC, 0, "ascii");
        hello.writeUInt16BE(tokenBytes.length, EGRESS_LINK_MAGIC.length);
        tokenBytes.copy(hello, EGRESS_LINK_MAGIC.length + 2);
        socket.write(hello);
    }

    async open(host: string, port: number): Promise<OpenResult> {
        const id = this.#nextStreamId++;
        this.#streams.set(id, { chunks: [], credit: 0, ended: false, onCredit: [], onData: [] });
        const hostBytes = Buffer.from(host, "utf8");
        const payload = Buffer.allocUnsafe(4 + hostBytes.length);
        payload.writeUInt16BE(port, 0);
        payload.writeUInt16BE(hostBytes.length, 2);
        hostBytes.copy(payload, 4);
        const result = new Promise<OpenResult>((resolve) => this.#opens.set(id, resolve));
        this.#socket.write(encodeEgressLinkFrame(egressLinkFrame.open, id, payload));
        return result;
    }

    async send(id: number, bytes: Buffer): Promise<void> {
        const stream = this.#streams.get(id);
        if (stream === undefined) throw new Error(`unknown stream ${String(id)}`);
        let offset = 0;
        // The proxy grants an initial window and replenishes it as the destination drains, so a
        // client that ignored credit would be a client the proxy is entitled to disconnect.
        stream.credit = stream.credit === 0 ? EGRESS_LINK_INITIAL_WINDOW_BYTES : stream.credit;
        while (offset < bytes.length) {
            if (stream.credit === 0) {
                await new Promise<void>((resolve) => stream.onCredit.push(resolve));
                continue;
            }
            const size = Math.min(bytes.length - offset, stream.credit, 32 * 1024);
            stream.credit -= size;
            this.#socket.write(
                encodeEgressLinkFrame(
                    egressLinkFrame.data,
                    id,
                    bytes.subarray(offset, offset + size),
                ),
            );
            offset += size;
        }
    }

    end(id: number): void {
        this.#socket.write(encodeEgressLinkFrame(egressLinkFrame.end, id, Buffer.alloc(0)));
    }

    async receiveAll(id: number): Promise<Buffer> {
        const stream = this.#streams.get(id);
        if (stream === undefined) throw new Error(`unknown stream ${String(id)}`);
        const collected: Buffer[] = [];
        for (;;) {
            while (stream.chunks.length > 0) {
                const chunk = stream.chunks.shift()!;
                collected.push(chunk);
                // Credit is returned as the bytes are consumed, exactly as the supervisor does.
                const payload = Buffer.allocUnsafe(4);
                payload.writeUInt32BE(chunk.length, 0);
                this.#socket.write(encodeEgressLinkFrame(egressLinkFrame.window, id, payload));
            }
            if (stream.ended) return Buffer.concat(collected);
            await new Promise<void>((resolve) => stream.onData.push(resolve));
        }
    }

    #consume(chunk: Buffer): void {
        this.#reader.push(chunk);
        if (!this.#authenticated) {
            if (chunk.length < EGRESS_LINK_MAGIC.length + 1) return;
            this.#authenticated = true;
            this.#resolveHandshake(chunk.readUInt8(EGRESS_LINK_MAGIC.length));
            this.#reader = new EgressLinkReader();
            const remainder = chunk.subarray(EGRESS_LINK_MAGIC.length + 1);
            if (remainder.length > 0) this.#reader.push(remainder);
        }
        let frame = this.#reader.takeFrame();
        while (frame !== undefined) {
            const stream = this.#streams.get(frame.streamId);
            if (frame.kind === egressLinkFrame.opened) {
                this.#opens.get(frame.streamId)?.({ status: "opened" });
            } else if (frame.kind === egressLinkFrame.refused) {
                this.#opens.get(frame.streamId)?.({
                    status: "refused",
                    reason: frame.payload.readUInt8(0),
                    message: frame.payload.toString("utf8", 1),
                });
            } else if (frame.kind === egressLinkFrame.data && stream !== undefined) {
                stream.chunks.push(frame.payload);
                stream.onData.splice(0).forEach((resume) => resume());
            } else if (frame.kind === egressLinkFrame.window && stream !== undefined) {
                stream.credit += frame.payload.readUInt32BE(0);
                stream.onCredit.splice(0).forEach((resume) => resume());
            } else if (
                (frame.kind === egressLinkFrame.end || frame.kind === egressLinkFrame.reset) &&
                stream !== undefined
            ) {
                stream.ended = true;
                stream.onData.splice(0).forEach((resume) => resume());
            }
            frame = this.#reader.takeFrame();
        }
    }
}

type OpenResult = { status: "opened" } | { message: string; reason: number; status: "refused" };

async function attachClient(
    proxy: UnifiedEgressProxy,
    token: string,
    options: { expectRefusal?: boolean } = {},
): Promise<LinkClient> {
    // A real pair of connected sockets stands in for the descriptor Rig connects and hands over.
    const server = createServer();
    const port = await listen(server);
    const linkArrived = new Promise<Socket>((resolve) => server.once("connection", resolve));
    const supervisorEnd = connect(port, "127.0.0.1");
    supervisorEnd.on("error", () => {});
    const hostEnd = await linkArrived;
    // Closing the listener only stops new connections; waiting for its callback would wait for
    // this very link to end.
    server.close();
    proxy.attach(hostEnd);
    const client = new LinkClient(supervisorEnd, token);
    cleanups.push(() => {
        supervisorEnd.destroy();
        hostEnd.destroy();
    });
    if (options.expectRefusal !== true) {
        expect(await client.handshakeStatus).toBe(0);
    }
    return client;
}
