/**
 * The frame layer of the link between a sandboxed supervisor and the unified egress proxy.
 *
 * One pre-connected descriptor carries every connection a command makes, so the descriptor needs
 * multiplexing. The protocol is deliberately tiny — the only thing being multiplexed is
 * `open_stream(host, port)` and its bytes — but it does carry per-stream credit, because one
 * workload connection that stops reading must not stall every other connection on the link.
 *
 * The Rust supervisor implements the same constants. They are duplicated rather than generated
 * because a generator between two languages is more machinery than nine bytes of header deserve.
 */

export const EGRESS_LINK_MAGIC = "HPX1";
export const EGRESS_LINK_HANDSHAKE_ACCEPTED = 0;
export const EGRESS_LINK_HANDSHAKE_REFUSED = 1;
export const EGRESS_LINK_FRAME_HEADER_BYTES = 9;
export const EGRESS_LINK_MAX_PAYLOAD_BYTES = 65_535;
export const EGRESS_LINK_MAX_CHUNK_BYTES = 32 * 1024;
export const EGRESS_LINK_INITIAL_WINDOW_BYTES = 256 * 1024;
export const EGRESS_LINK_MAX_STREAMS = 256;
export const EGRESS_LINK_MAX_TOKEN_BYTES = 512;
export const EGRESS_LINK_MAX_HOST_BYTES = 255;

export const egressLinkFrame = {
    open: 1,
    opened: 2,
    refused: 3,
    data: 4,
    end: 5,
    reset: 6,
    window: 7,
} as const;

/** Why a stream was refused, in the vocabulary each front-end translates into its own. */
export const egressLinkRefusal = {
    blocked: 1,
    unresolvable: 2,
    unreachable: 3,
} as const;

export interface EgressLinkFrame {
    kind: number;
    payload: Buffer;
    streamId: number;
}

export function encodeEgressLinkFrame(kind: number, streamId: number, payload: Buffer): Buffer {
    const frame = Buffer.allocUnsafe(EGRESS_LINK_FRAME_HEADER_BYTES + payload.length);
    frame.writeUInt8(kind, 0);
    frame.writeUInt32BE(streamId, 1);
    frame.writeUInt32BE(payload.length, 5);
    payload.copy(frame, EGRESS_LINK_FRAME_HEADER_BYTES);
    return frame;
}

export function encodeEgressLinkRefusal(reason: number, message: string): Buffer {
    return Buffer.concat([Buffer.from([reason]), Buffer.from(message.slice(0, 256), "utf8")]);
}

export function encodeEgressLinkHandshakeReply(status: number): Buffer {
    return Buffer.concat([Buffer.from(EGRESS_LINK_MAGIC, "ascii"), Buffer.from([status])]);
}

/** A destination the supervisor asked for, still unvalidated. */
export interface EgressLinkOpenRequest {
    host: string;
    port: number;
}

export function decodeEgressLinkOpenRequest(payload: Buffer): EgressLinkOpenRequest | undefined {
    if (payload.length < 4) return undefined;
    const port = payload.readUInt16BE(0);
    const hostLength = payload.readUInt16BE(2);
    if (hostLength === 0 || payload.length !== 4 + hostLength) return undefined;
    return { host: payload.toString("utf8", 4, 4 + hostLength), port };
}

/**
 * Incremental reader for one link.
 *
 * A malformed length or an oversized token is a protocol violation rather than a recoverable
 * condition, so it throws and the caller drops the link instead of resynchronising on a guess.
 */
export class EgressLinkReader {
    #buffered: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): void {
        this.#buffered =
            this.#buffered.length === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);
    }

    /** Returns the authentication token once the whole handshake has arrived. */
    takeHandshakeToken(): string | undefined {
        const prefix = EGRESS_LINK_MAGIC.length + 2;
        if (this.#buffered.length < prefix) return undefined;
        if (this.#buffered.toString("ascii", 0, EGRESS_LINK_MAGIC.length) !== EGRESS_LINK_MAGIC) {
            throw new Error("The sandbox link did not begin with the expected protocol magic.");
        }
        const length = this.#buffered.readUInt16BE(EGRESS_LINK_MAGIC.length);
        if (length === 0 || length > EGRESS_LINK_MAX_TOKEN_BYTES) {
            throw new Error("The sandbox link presented an unusable authentication token length.");
        }
        if (this.#buffered.length < prefix + length) return undefined;
        const token = this.#buffered.toString("utf8", prefix, prefix + length);
        this.#buffered = this.#buffered.subarray(prefix + length);
        return token;
    }

    takeFrame(): EgressLinkFrame | undefined {
        if (this.#buffered.length < EGRESS_LINK_FRAME_HEADER_BYTES) return undefined;
        const length = this.#buffered.readUInt32BE(5);
        if (length > EGRESS_LINK_MAX_PAYLOAD_BYTES) {
            throw new Error("The sandbox link sent a frame larger than the protocol allows.");
        }
        const total = EGRESS_LINK_FRAME_HEADER_BYTES + length;
        if (this.#buffered.length < total) return undefined;
        const frame: EgressLinkFrame = {
            kind: this.#buffered.readUInt8(0),
            payload: Buffer.from(this.#buffered.subarray(EGRESS_LINK_FRAME_HEADER_BYTES, total)),
            streamId: this.#buffered.readUInt32BE(1),
        };
        this.#buffered = this.#buffered.subarray(total);
        return frame;
    }
}
