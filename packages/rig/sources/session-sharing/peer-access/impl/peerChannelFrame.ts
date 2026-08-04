/**
 * One discriminator byte, then the payload. That is the entire peer framing.
 *
 * The terminal payload is one complete ghostty-web wire packet, byte for byte
 * what the WebSocket transport already carries, so no terminal protocol code
 * exists on this path at all — only the byte that says which of two streams a
 * frame belongs to.
 */
export const PEER_FRAME_CONTROL = 0x00;
export const PEER_FRAME_TERMINAL = 0x01;

export type PeerFrameKind = typeof PEER_FRAME_CONTROL | typeof PEER_FRAME_TERMINAL;

export interface PeerFrame {
    readonly bytes: Uint8Array;
    readonly kind: PeerFrameKind;
}

export function encodePeerFrame(kind: PeerFrameKind, bytes: Uint8Array): Uint8Array {
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = kind;
    frame.set(bytes, 1);
    return frame;
}

/** Decode one frame, or `undefined` when the bytes are not a frame at all. */
export function decodePeerFrame(frame: Uint8Array): PeerFrame | undefined {
    const kind = frame[0];
    if (kind !== PEER_FRAME_CONTROL && kind !== PEER_FRAME_TERMINAL) return undefined;
    return { bytes: frame.subarray(1), kind };
}

/** Everything the control stream can say. Flow control and closing, nothing else. */
export type PeerControl =
    | { readonly reason: string; readonly type: "closed" }
    | { readonly type: "pause" }
    | { readonly type: "resume" };

const MAX_CONTROL_REASON = 512;

export function encodePeerControl(control: PeerControl): Uint8Array {
    return encodePeerFrame(
        PEER_FRAME_CONTROL,
        new TextEncoder().encode(
            JSON.stringify(
                control.type === "closed"
                    ? { reason: control.reason.slice(0, MAX_CONTROL_REASON), type: "closed" }
                    : { type: control.type },
            ),
        ),
    );
}

export function decodePeerControl(bytes: Uint8Array): PeerControl | undefined {
    if (bytes.length > MAX_CONTROL_REASON + 64) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const type = (parsed as { type?: unknown }).type;
    if (type === "pause" || type === "resume") return { type };
    if (type === "closed") {
        const reason = (parsed as { reason?: unknown }).reason;
        return {
            reason:
                typeof reason === "string" && reason.length > 0
                    ? reason.slice(0, MAX_CONTROL_REASON)
                    : "The shared terminal closed.",
            type: "closed",
        };
    }
    return undefined;
}
