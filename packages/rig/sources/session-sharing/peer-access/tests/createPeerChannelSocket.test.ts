import { describe, expect, it } from "vitest";

import type {
    SharedSessionEphemeralChannel,
    SharedSessionEphemeralDrop,
    SharedSessionEphemeralEpochChange,
    SharedSessionEphemeralFrame,
} from "@slopus/murmur/sharedSession";

import type { BinaryWebSocketHandlers } from "../../../terminal/BinaryWebSocket.js";
import { createPeerChannelSocket } from "../impl/createPeerChannelSocket.js";
import { encodePeerFrame, PEER_FRAME_TERMINAL } from "../impl/peerChannelFrame.js";

type FakeChannel = SharedSessionEphemeralChannel & {
    emitDropped: (drop: SharedSessionEphemeralDrop) => void;
    emitEpochChanged: (change: SharedSessionEphemeralEpochChange) => void;
    emitReceived: (frame: SharedSessionEphemeralFrame) => void;
};

function fakeChannel(): FakeChannel {
    const receivedHandlers = new Set<(frame: SharedSessionEphemeralFrame) => void>();
    const droppedHandlers = new Set<(drop: SharedSessionEphemeralDrop) => void>();
    const epochHandlers = new Set<(change: SharedSessionEphemeralEpochChange) => void>();
    return {
        close: () => undefined,
        emitDropped: (drop) => {
            for (const handler of [...droppedHandlers]) handler(drop);
        },
        emitEpochChanged: (change) => {
            for (const handler of [...epochHandlers]) handler(change);
        },
        emitReceived: (frame) => {
            for (const handler of [...receivedHandlers]) handler(frame);
        },
        epoch: 1,
        onDropped: (handler) => {
            droppedHandlers.add(handler);
            return () => droppedHandlers.delete(handler);
        },
        onEpochChanged: (handler) => {
            epochHandlers.add(handler);
            return () => epochHandlers.delete(handler);
        },
        onReceived: (handler) => {
            receivedHandlers.add(handler);
            return () => receivedHandlers.delete(handler);
        },
        open: true,
        send: () => undefined,
    };
}

function terminalFrame(bytes: Uint8Array): SharedSessionEphemeralFrame {
    return {
        authenticatedPeerId: "peer-1",
        bytes: encodePeerFrame(PEER_FRAME_TERMINAL, bytes),
        grantEpoch: 1,
        shareMemberId: "member-1",
    };
}

function collectHandlers(): {
    handlers: BinaryWebSocketHandlers;
    state: { closed: boolean; errors: Error[]; messages: Uint8Array[] };
} {
    const state = { closed: false, errors: [] as Error[], messages: [] as Uint8Array[] };
    const handlers: BinaryWebSocketHandlers = {
        close: () => {
            state.closed = true;
        },
        error: (error) => {
            state.errors.push(error);
        },
        message: (data) => {
            state.messages.push(data);
        },
    };
    return { handlers, state };
}

describe("createPeerChannelSocket", () => {
    it("ends the socket rather than growing its inbound queue past the bound while paused", () => {
        const channel = fakeChannel();
        const closedReasons: string[] = [];
        const socket = createPeerChannelSocket({
            channel,
            isExpectedSender: () => true,
            onClosed: (reason) => closedReasons.push(reason),
        });
        const { handlers, state } = collectHandlers();
        socket.subscribe(handlers);
        socket.pause?.();

        // Each chunk is 300 KB; four of them cross the 1 MiB inbound bound while paused.
        const chunk = new Uint8Array(300_000);
        for (let index = 0; index < 4; index += 1) channel.emitReceived(terminalFrame(chunk));

        expect(state.errors).toHaveLength(1);
        expect(closedReasons).toHaveLength(1);
        expect(state.messages).toHaveLength(0);
    });

    it("ends the socket when the channel reports a dropped frame", () => {
        const channel = fakeChannel();
        const closedReasons: string[] = [];
        const socket = createPeerChannelSocket({
            channel,
            isExpectedSender: () => true,
            onClosed: (reason) => closedReasons.push(reason),
        });
        const { handlers, state } = collectHandlers();
        socket.subscribe(handlers);

        channel.emitDropped({ direction: "inbound", frames: 1, reason: "queue-overflow" });

        expect(state.errors).toHaveLength(1);
        expect(closedReasons).toHaveLength(1);

        // A frame arriving after the drop must not be delivered: the connection is over.
        channel.emitReceived(terminalFrame(new Uint8Array([1])));
        expect(state.messages).toHaveLength(0);
    });

    it("ends the socket when the channel's epoch changes", () => {
        const channel = fakeChannel();
        const closedReasons: string[] = [];
        const socket = createPeerChannelSocket({
            channel,
            isExpectedSender: () => true,
            onClosed: (reason) => closedReasons.push(reason),
        });
        const { handlers, state } = collectHandlers();
        socket.subscribe(handlers);

        channel.emitEpochChanged({ localEpoch: 2, observedEpoch: 3, reason: "peer-ahead" });

        expect(state.errors).toHaveLength(1);
        expect(closedReasons).toHaveLength(1);
    });
});
