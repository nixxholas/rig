import type { SharedSessionEphemeralChannel } from "@slopus/murmur/sharedSession";

import type { PermissionMode } from "../../permissions/PermissionMode.js";
import type { RemoteTerminal } from "../../terminal/RemoteTerminal.js";
import { WebSocketDuplex } from "../../terminal/WebSocketDuplex.js";
import { createPeerChannelSocket } from "./impl/createPeerChannelSocket.js";
import {
    isPeerTerminalConfined,
    PEER_TERMINAL_NEEDS_CONTAINER,
    PEER_TERMINAL_NEEDS_SOLE_MEMBER,
} from "./impl/peerTerminalConfinement.js";
import type { PeerCapabilityContext } from "./PeerCapabilityContext.js";
import type { PeerCapabilityDecision } from "./types.js";

/**
 * How many terminals may be mirrored to peers at a time, counted across every
 * share this service serves — one service is constructed per daemon, so this
 * bound is daemon-wide rather than per session.
 *
 * One, and the reason is the transport rather than a budget. Murmur's ephemeral
 * channel is one lossy, epoch-keyed broadcast per shared session: there is
 * exactly one channel, every member of the group decrypts everything on it, and
 * a frame carries no attachment identifier. Two concurrent attachments would
 * interleave two terminals' wire packets into one byte stream that neither
 * decoder could resynchronize, and the peer socket ends on exactly that kind of
 * hole.
 *
 * So the honest bound is one. A peer attachment is an extra `attach` on a
 * terminal the owner already opened, so it consumes no `MAX_TERMINALS` slot of
 * its own; a bound of one additionally means a peer reattaching in a loop can
 * never starve the owner out of their own terminals.
 */
export const MAX_PEER_ATTACHED_TERMINALS = 1;

export interface PeerTerminalViewerOptions {
    /**
     * How many members of this share are active right now.
     *
     * Load-bearing, not informational. See `MAX_PEER_ATTACHED_TERMINALS`.
     */
    readonly activeMemberCount: (shareId: string) => number;
    readonly capabilities: PeerCapabilityContext;
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

        const refuse = (reason: string): PeerTerminalAttachResult =>
            denied(
                capabilities.deny(
                    {
                        action: { detail: request.terminalId, name: "attach" },
                        capability: "terminal_view",
                        grantEpoch: request.grantEpoch,
                        shareId: request.shareId,
                        shareMemberId: request.shareMemberId,
                    },
                    reason,
                ),
            );

        // Everything on the peer channel reaches every member of the group, because
        // Murmur keys it from the epoch that carries the transcript and gives a
        // shared session exactly one such channel. Mirroring to one member of a
        // larger share would therefore hand the terminal to members who were never
        // granted anything, which is precisely the boundary this feature exists to
        // draw. Until the transport can address one member, a share with anyone
        // else in it cannot mirror a terminal at all.
        if (this.#options.activeMemberCount(request.shareId) > 1) {
            return refuse(PEER_TERMINAL_NEEDS_SOLE_MEMBER);
        }

        const terminal = this.#options.terminal(request.shareId, request.terminalId);
        if (terminal === undefined) return refuse("That terminal is not open any more.");

        // Asked of the terminal, never of the project: a project that gained a
        // container after this terminal started still has a host shell running in
        // it, and that shell reads the owner's credentials.
        if (!isPeerTerminalConfined(terminal.confinement)) {
            return refuse(PEER_TERMINAL_NEEDS_CONTAINER);
        }

        const key = `${request.shareMemberId}\u0000${request.terminalId}`;
        // Counted after the same-key replace is accounted for, so a peer that
        // already holds this terminal can always reattach to it rather than being
        // refused by the bound it is itself occupying.
        if (!this.#attachments.has(key) && this.#attachments.size >= MAX_PEER_ATTACHED_TERMINALS) {
            return refuse(
                "Rig is already mirroring a terminal to somebody. Close that one before opening another.",
            );
        }
        // Reattaching replaces rather than adds. Otherwise a friend whose channel died
        // without a close would accumulate one attachment per reconnect against the
        // very bound that is meant to stop them from doing so.
        this.#attachments.get(key)?.();

        // The revision is per member, so another member's grant changing cannot
        // invalidate this attachment; only a change to this member's own can.
        const scope = { shareId: request.shareId, shareMemberId: request.shareMemberId };
        const revision = capabilities.revision(scope);
        let released = false;
        let detachTerminal: (() => void) | undefined;
        let stream: WebSocketDuplex | undefined;

        // Declared and registered before anything that could close or throw. A
        // release that ran earlier would read `unregister` before its declaration,
        // and a throw from `terminal.attach` after the socket exists but before the
        // attachment is tracked would leave a subscribed socket nobody can release.
        const release = (): void => {
            if (released) return;
            released = true;
            this.#attachments.delete(key);
            unregister();
            detachTerminal?.();
            stream?.destroy();
        };
        const unregister = capabilities.register({
            capability: "terminal_view",
            close: () => release(),
            grantEpoch: request.grantEpoch,
            shareId: request.shareId,
            shareMemberId: request.shareMemberId,
        });
        this.#attachments.set(key, release);

        try {
            const socket = createPeerChannelSocket({
                channel: request.channel,
                isExpectedSender: (frame) =>
                    frame.authenticatedPeerId === request.peerId &&
                    frame.shareMemberId === request.shareMemberId &&
                    frame.grantEpoch === request.grantEpoch &&
                    // The decision this attachment opened under has to still be the
                    // current one. A revoke bumps this member's revision, so a frame
                    // that raced the close is refused on the same check that
                    // authorized the attachment.
                    capabilities.isCurrent(scope, revision),
                onClosed: () => release(),
            });

            stream = new WebSocketDuplex(socket);
            stream.once("close", () => release());
            detachTerminal = terminal.attach(stream, { input: false });
        } catch (error: unknown) {
            release();
            throw error;
        }

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
