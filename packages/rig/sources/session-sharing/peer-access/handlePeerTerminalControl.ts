import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SharedSessionEphemeralChannel } from "@slopus/murmur/sharedSession";

import type { ShareTransportMemberControl } from "../../sharing/ShareTransport.js";
import type { PeerTerminalViewerService } from "./PeerTerminalViewerService.js";

/** Control frame a member sends to ask to watch one terminal. */
export const PEER_TERMINAL_ATTACH_CONTROL_ID = "peer.terminal.attach";

export const peerTerminalAttachPayloadSchema = Type.Object(
    { terminalId: Type.String({ maxLength: 256, minLength: 1 }) },
    { additionalProperties: false },
);
export type PeerTerminalAttachPayload = Static<typeof peerTerminalAttachPayloadSchema>;

export interface PeerTerminalControlOptions {
    /** The share's peer channel, or `undefined` when this daemon has none open. */
    readonly channel: (shareId: string) => SharedSessionEphemeralChannel | undefined;
    readonly viewer: PeerTerminalViewerService;
}

export type PeerTerminalControlResult =
    | { readonly outcome: "attached" }
    | { readonly outcome: "ignored" }
    | { readonly outcome: "denied"; readonly reason: string };

/**
 * Turn one authenticated member control frame into a peer terminal attachment.
 *
 * Everything that identifies the requester — peer ID, member ID, grant epoch —
 * is taken from the frame Murmur authenticated, never from the payload. The
 * payload names only which terminal, and is validated before it is read, so a
 * malformed frame is ignored rather than partially interpreted.
 *
 * Nothing here decides whether the request is allowed. That is entirely the
 * viewer's two gates plus the confinement precondition, which is why this
 * function has no idea what a capability is.
 */
export function handlePeerTerminalControl(
    control: ShareTransportMemberControl,
    options: PeerTerminalControlOptions,
): PeerTerminalControlResult {
    if (control.controlId !== PEER_TERMINAL_ATTACH_CONTROL_ID) return { outcome: "ignored" };
    if (!Value.Check(peerTerminalAttachPayloadSchema, control.payload)) {
        return { outcome: "ignored" };
    }
    const channel = options.channel(control.shareId);
    // No channel means this daemon does not hold that session's transport. There
    // is nothing to refuse and nothing to audit: the request was never ours.
    if (channel === undefined || !channel.open) return { outcome: "ignored" };
    const result = options.viewer.attach({
        channel,
        grantEpoch: control.grantEpoch,
        peerId: control.authenticatedPeerId,
        shareId: control.shareId,
        shareMemberId: control.shareMemberId,
        terminalId: control.payload.terminalId,
    });
    return result.outcome === "attached"
        ? { outcome: "attached" }
        : { outcome: "denied", reason: result.reason };
}
