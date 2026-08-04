import type { SharedSessionEphemeralChannel } from "@slopus/murmur/sharedSession";

import type { DockerExecutionConfig } from "../../execution/index.js";
import type { PermissionMode } from "../../permissions/PermissionMode.js";
import type { RemoteTerminal } from "../../terminal/RemoteTerminal.js";
import { WebSocketDuplex } from "../../terminal/WebSocketDuplex.js";
import { createPeerChannelSocket } from "./impl/createPeerChannelSocket.js";
import { resolvePeerTerminalConfinement } from "./impl/peerTerminalConfinement.js";
import type { PeerCapabilityContext } from "./PeerCapabilityContext.js";
import type { PeerCapabilityDecision } from "./types.js";

/**
 * How many terminals every peer in one session may hold open, all together.
 *
 * Terminals share the project's `MAX_TERMINALS` budget, so without a smaller
 * bound of their own a friend reattaching in a loop would starve the owner out
 * of their own terminals. Four is enough to watch what a person actually
 * watches, and small enough that exhausting it costs the owner nothing.
 */
export const MAX_PEER_ATTACHED_TERMINALS = 4;

export interface PeerTerminalViewerOptions {
    readonly capabilities: PeerCapabilityContext;
    /** Docker execution config of the project this session runs in, if it has one. */
    readonly docker: (shareId: string) => DockerExecutionConfig | undefined;
    /** Terminal to mirror, or `undefined` when it does not exist any more. */
    readonly terminal: (shareId: string, terminalId: string) => RemoteTerminal | undefined;
}

export interface PeerTerminalAttachRequest {
    readonly channel: SharedSessionEphemeralChannel;
    readonly grantEpoch: number;
    /** Murmur peer ID a frame must carry to be read on this attachment. */
    readonly peerId: string;
    readonly shareId: string;
    readonly shareMemberId: string;
    readonly terminalId: string;
}

export type PeerTerminalAttachResult =
    | { readonly detach: () => void; readonly outcome: "attached" }
    | { readonly outcome: "denied"; readonly reason: string };

/**
 * Mirrors one container terminal to one friend, and nothing more.
 *
 * The PTY is always the owner's. A friend gets an additional `attach`, the same
 * call the WebSocket transport already makes, with `input: false` — so
 * snapshot-then-deltas, resize barriers, epoch invalidation, and credit-based
 * flow control are inherited rather than rebuilt, and "no input lease" is an
 * existing tested state of the protocol rather than a new one.
 *
 * Both gates run here, in this order and every time:
 *
 * 1. the grant exists, is active, and is at the member's current epoch;
 * 2. the capability's ceiling, resolved against the session's live mode.
 *
 * Then the confinement precondition, which is not a permission question at all:
 * a terminal on the owner's own machine reads the owner's credentials, so it is
 * never mirrored to anybody, in any mode, for any reason.
 */
export class PeerTerminalViewerService {
    readonly #attachments = new Map<string, () => void>();
    readonly #options: PeerTerminalViewerOptions;

    constructor(options: PeerTerminalViewerOptions) {
        this.#options = options;
    }

    /** How many peer attachments are open right now, across every member. */
    get attachedCount(): number {
        return this.#attachments.size;
    }

    attach(request: PeerTerminalAttachRequest): PeerTerminalAttachResult {
        const capabilities = this.#options.capabilities;
        const authorization = capabilities.authorize({
            action: { detail: request.terminalId, name: "attach" },
            capability: "terminal_view",
            grantEpoch: request.grantEpoch,
            shareId: request.shareId,
            shareMemberId: request.shareMemberId,
        });
        if (authorization.outcome === "denied") return denied(authorization);

        const confinement = resolvePeerTerminalConfinement(this.#options.docker(request.shareId));
        if ("reason" in confinement) {
            return denied(
                capabilities.deny(
                    {
                        action: { detail: request.terminalId, name: "attach" },
                        capability: "terminal_view",
                        grantEpoch: request.grantEpoch,
                        shareId: request.shareId,
                        shareMemberId: request.shareMemberId,
                    },
                    confinement.reason,
                ),
            );
        }

        if (this.#attachments.size >= MAX_PEER_ATTACHED_TERMINALS) {
            return denied(
                capabilities.deny(
                    {
                        action: { detail: request.terminalId, name: "attach" },
                        capability: "terminal_view",
                        grantEpoch: request.grantEpoch,
                        shareId: request.shareId,
                        shareMemberId: request.shareMemberId,
                    },
                    "This session already has as many shared terminals open as it allows. Close one and try again.",
                ),
            );
        }

        const terminal = this.#options.terminal(request.shareId, request.terminalId);
        if (terminal === undefined) {
            return denied(
                capabilities.deny(
                    {
                        action: { detail: request.terminalId, name: "attach" },
                        capability: "terminal_view",
                        grantEpoch: request.grantEpoch,
                        shareId: request.shareId,
                        shareMemberId: request.shareMemberId,
                    },
                    "That terminal is not open any more.",
                ),
            );
        }

        const key = `${request.shareMemberId}\u0000${request.terminalId}`;
        // Reattaching replaces rather than adds. Otherwise a friend whose channel died
        // without a close would accumulate one attachment per reconnect against the
        // very bound that is meant to stop them from doing so.
        this.#attachments.get(key)?.();

        const revision = capabilities.revision;
        let released = false;
        let detachTerminal: (() => void) | undefined;
        let stream: WebSocketDuplex | undefined;

        const release = (): void => {
            if (released) return;
            released = true;
            this.#attachments.delete(key);
            unregister?.();
            detachTerminal?.();
            stream?.destroy();
        };

        const socket = createPeerChannelSocket({
            channel: request.channel,
            isExpectedSender: (frame) =>
                frame.authenticatedPeerId === request.peerId &&
                frame.shareMemberId === request.shareMemberId &&
                frame.grantEpoch === request.grantEpoch &&
                // The decision this attachment opened under has to still be the current
                // one. A revoke bumps the revision, so a frame that raced the close is
                // refused on the same check that authorized the attachment.
                capabilities.isCurrent(revision),
            onClosed: () => release(),
        });

        stream = new WebSocketDuplex(socket);
        stream.once("close", () => release());
        detachTerminal = terminal.attach(stream, { input: false });

        const unregister = capabilities.register({
            capability: "terminal_view",
            close: () => release(),
            grantEpoch: request.grantEpoch,
            shareId: request.shareId,
            shareMemberId: request.shareMemberId,
        });

        this.#attachments.set(key, release);
        return { detach: release, outcome: "attached" };
    }

    /** Release every peer attachment, for shutdown rather than for a revocation. */
    close(): void {
        for (const release of [...this.#attachments.values()]) release();
        this.#attachments.clear();
    }
}

/**
 * The mode a peer terminal actually runs under, for anything that has to say so.
 *
 * Exposed because it is the answer to "what could they do", and a UI that shows
 * a capability must be able to show that too.
 */
export function peerTerminalEffectiveMode(
    decision: PeerCapabilityDecision,
): PermissionMode | undefined {
    return decision.outcome === "allowed" ? decision.effectiveMode : undefined;
}

function denied(decision: PeerCapabilityDecision): PeerTerminalAttachResult {
    return {
        outcome: "denied",
        reason:
            decision.outcome === "denied"
                ? decision.reason
                : "You do not have permission to do this in this shared session.",
    };
}
