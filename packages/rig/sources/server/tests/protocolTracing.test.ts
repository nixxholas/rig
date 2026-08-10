import { describe, expect, it } from "vitest";

import { shouldTraceProtocolRoute } from "../protocolTracing.js";

describe("protocol tracing", () => {
    it.each([
        "global-events-stream",
        "live-events-stream",
        "stream",
        "peer.global-events-stream",
        "peer.live-events-stream",
        "peer.stream",
    ])("does not trace the long-running %s route", (route) => {
        expect(shouldTraceProtocolRoute(route)).toBe(false);
    });

    it.each(["session-state", "session-transcript", "peer.session-state"])(
        "traces the bounded %s route",
        (route) => {
            expect(shouldTraceProtocolRoute(route)).toBe(true);
        },
    );
});
