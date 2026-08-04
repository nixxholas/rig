import { describe, expect, it } from "vitest";

import {
    decodePeerControl,
    decodePeerFrame,
    encodePeerControl,
    encodePeerFrame,
    PEER_FRAME_CONTROL,
    PEER_FRAME_TERMINAL,
} from "../impl/peerChannelFrame.js";

describe("peerChannelFrame", () => {
    it("round-trips a terminal frame", () => {
        const payload = new Uint8Array([1, 2, 3, 4, 5]);
        const encoded = encodePeerFrame(PEER_FRAME_TERMINAL, payload);

        const decoded = decodePeerFrame(encoded);

        expect(decoded?.kind).toBe(PEER_FRAME_TERMINAL);
        expect([...decoded!.bytes]).toEqual([...payload]);
    });

    it("round-trips a pause control frame", () => {
        const encoded = encodePeerControl({ type: "pause" });

        const decodedFrame = decodePeerFrame(encoded);
        expect(decodedFrame?.kind).toBe(PEER_FRAME_CONTROL);
        expect(decodePeerControl(decodedFrame!.bytes)).toEqual({ type: "pause" });
    });

    it("round-trips a closed control frame with its reason", () => {
        const encoded = encodePeerControl({ reason: "The owner ended the share.", type: "closed" });

        const decodedFrame = decodePeerFrame(encoded)!;

        expect(decodePeerControl(decodedFrame.bytes)).toEqual({
            reason: "The owner ended the share.",
            type: "closed",
        });
    });

    it("decodes a truncated (empty) frame as invalid rather than throwing", () => {
        expect(decodePeerFrame(new Uint8Array(0))).toBeUndefined();
    });

    it("decodes a frame with an unknown discriminator byte as invalid rather than throwing", () => {
        expect(decodePeerFrame(new Uint8Array([0x02, 1, 2, 3]))).toBeUndefined();
    });

    it("decodes a malformed control payload as invalid rather than throwing", () => {
        const malformed = encodePeerFrame(PEER_FRAME_CONTROL, new TextEncoder().encode("not json"));

        const decodedFrame = decodePeerFrame(malformed)!;

        expect(decodePeerControl(decodedFrame.bytes)).toBeUndefined();
    });
});
