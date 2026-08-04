import {
    MAX_SHARED_SESSION_EPHEMERAL_BYTES,
    type SharedSessionEphemeralChannel,
    type SharedSessionEphemeralFrame,
} from "@slopus/murmur/sharedSession";

import type {
    BinaryWebSocket,
    BinaryWebSocketHandlers,
} from "../../../terminal/BinaryWebSocket.js";
import {
    decodePeerControl,
    decodePeerFrame,
    encodePeerControl,
    encodePeerFrame,
    PEER_FRAME_TERMINAL,
} from "./peerChannelFrame.js";

/** Payload room in one ephemeral frame once the discriminator byte is spent. */
const MAX_PEER_PAYLOAD_BYTES = MAX_SHARED_SESSION_EPHEMERAL_BYTES - 1;

/** Inbound bytes held while the reader is paused, before the attachment is dropped. */
const MAX_PEER_INBOUND_BYTES = 1024 * 1024;

export interface PeerChannelSocketOptions {
    /** Non-durable, epoch-keyed channel of the shared session. */
    readonly channel: SharedSessionEphemeralChannel;
    /** True for a frame this side is willing to read. Everything else is ignored. */
    readonly isExpectedSender: (frame: SharedSessionEphemeralFrame) => boolean;
    /** Called once when the socket ends, with the sentence explaining why. */
    readonly onClosed?: (reason: string) => void;
}

/**
 * The peer channel, wearing the interface the terminal transport already speaks.
 *
 * `WebSocketDuplex` and the ghostty-web replica are built against
 * `BinaryWebSocket`, and `RemoteTerminal.attach` is built against a `Duplex`.
 * Presenting the Murmur channel as one `BinaryWebSocket` is therefore the whole
 * integration: snapshot-then-deltas, resize barriers, input leases, epoch
 * invalidation, and credit-based flow control all arrive unchanged, and no new
 * terminal protocol code exists on this path.
 *
 * Frame boundaries carry no meaning. Both ends run `WirePacketDecoder` over a
 * byte stream, so a write is split to fit the epoch's frame budget and the
 * decoder reassembles it. What frame boundaries cannot survive is loss: a
 * dropped frame is a hole in the stream, so a drop ends the attachment rather
 * than corrupting it. Reattaching is cheap — the protocol opens with a snapshot.
 */
export function createPeerChannelSocket(options: PeerChannelSocketOptions): BinaryWebSocket {
    const subscribers = new Set<BinaryWebSocketHandlers>();
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let paused = false;
    let closed = false;
    let unsubscribeReceived: (() => void) | undefined;
    let unsubscribeDropped: (() => void) | undefined;
    let unsubscribeEpoch: (() => void) | undefined;

    const releaseChannel = (): void => {
        unsubscribeReceived?.();
        unsubscribeDropped?.();
        unsubscribeEpoch?.();
        unsubscribeReceived = undefined;
        unsubscribeDropped = undefined;
        unsubscribeEpoch = undefined;
    };

    const finish = (reason: string, error?: Error): void => {
        if (closed) return;
        closed = true;
        pending.length = 0;
        pendingBytes = 0;
        releaseChannel();
        const handlers = [...subscribers];
        subscribers.clear();
        for (const handler of handlers) {
            if (error === undefined) handler.close();
            else handler.error(error);
        }
        options.onClosed?.(reason);
    };

    const deliver = (bytes: Uint8Array): void => {
        for (const handler of [...subscribers]) handler.message(bytes);
    };

    const drain = (): void => {
        while (!paused && !closed && pending.length > 0) {
            const next = pending.shift()!;
            pendingBytes -= next.length;
            deliver(next);
        }
    };

    unsubscribeReceived = options.channel.onReceived((frame) => {
        if (closed || !options.isExpectedSender(frame)) return;
        const decoded = decodePeerFrame(frame.bytes);
        if (decoded === undefined) {
            finish(
                "The shared terminal connection sent something Rig could not read.",
                new Error("The shared terminal connection sent an unreadable frame."),
            );
            return;
        }
        if (decoded.kind === PEER_FRAME_TERMINAL) {
            if (paused) {
                if (pendingBytes + decoded.bytes.length > MAX_PEER_INBOUND_BYTES) {
                    finish(
                        "The shared terminal fell too far behind, so Rig closed it. Open it again to catch up.",
                        new Error("The shared terminal receive buffer is full."),
                    );
                    return;
                }
                pending.push(Uint8Array.prototype.slice.call(decoded.bytes));
                pendingBytes += decoded.bytes.length;
                return;
            }
            deliver(decoded.bytes);
            return;
        }
        const control = decodePeerControl(decoded.bytes);
        if (control === undefined) return;
        if (control.type === "closed") finish(control.reason);
        // `pause` and `resume` describe the sender's own reader. Nothing local acts on
        // them: the terminal protocol's credit accounting is the real backpressure, and
        // a second mechanism fighting it would only produce stalls it cannot explain.
    });

    unsubscribeDropped = options.channel.onDropped((drop) => {
        // A dropped frame is a hole in an ordered byte stream, and the wire decoder
        // would fail on the next packet header rather than resynchronize. Ending here
        // says so honestly; the protocol reopens with a fresh snapshot.
        finish(
            `The shared terminal lost ${String(drop.frames)} ${drop.frames === 1 ? "frame" : "frames"}, so Rig closed it. Open it again to catch up.`,
            new Error("The shared terminal connection dropped frames."),
        );
    });

    unsubscribeEpoch = options.channel.onEpochChanged(() => {
        // Membership changed, so every key this channel used is already void.
        finish(
            "Access to this shared session changed, so the shared terminal closed.",
            new Error("The shared session epoch changed."),
        );
    });

    return {
        get bufferedAmount() {
            // The channel queues and drops on its own bound rather than reporting a
            // depth, and the terminal protocol's credit window is what actually paces
            // this stream. Reporting zero keeps `WebSocketDuplex` from waiting on a
            // number that will never move.
            return 0;
        },
        close() {
            if (closed) return;
            if (options.channel.open) {
                try {
                    options.channel.send(encodePeerControl({ reason: "closed", type: "closed" }));
                } catch {
                    // Telling the other side is a courtesy. The local close is the part
                    // that matters and must not depend on it.
                }
            }
            finish("The shared terminal closed.");
        },
        pause() {
            paused = true;
        },
        resume() {
            paused = false;
            drain();
        },
        send(data, callback) {
            if (closed) {
                callback(new Error("The shared terminal connection is closed."));
                return;
            }
            if (!options.channel.open) {
                finish("The shared terminal closed.");
                callback(new Error("The shared terminal connection is closed."));
                return;
            }
            try {
                for (let offset = 0; offset < data.length; offset += MAX_PEER_PAYLOAD_BYTES) {
                    options.channel.send(
                        encodePeerFrame(
                            PEER_FRAME_TERMINAL,
                            data.subarray(offset, offset + MAX_PEER_PAYLOAD_BYTES),
                        ),
                    );
                }
            } catch (error: unknown) {
                callback(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            callback();
        },
        subscribe(handlers) {
            subscribers.add(handlers);
            if (closed) queueMicrotask(() => handlers.close());
            return () => {
                subscribers.delete(handlers);
            };
        },
    };
}
