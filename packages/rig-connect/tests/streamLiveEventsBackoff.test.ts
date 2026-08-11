import { describe, expect, it } from "vitest";

import { streamLiveEvents } from "@/streamLiveEvents.js";

const CURSOR = "01900000-0000-7000-8000-000000000001";

describe("live stream reconnect backoff", () => {
    it("keeps backing off when the daemon accepts a stream and immediately closes it", async () => {
        const controller = new AbortController();
        const waits: number[] = [];
        const fetch = async () =>
            new Response(
                `event: hello\ndata: ${JSON.stringify({
                    cursor: CURSOR,
                    gap: false,
                    protocolVersion: 17,
                    resumed: false,
                })}\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            );

        await streamLiveEvents({
            endpoint: "http://daemon.test",
            fetch: fetch as typeof globalThis.fetch,
            onDisconnected: () => undefined,
            onEvent: () => undefined,
            onOpen: () => undefined,
            retryDelayMs: 10,
            signal: controller.signal,
            token: "secret",
            wait: async (ms) => {
                waits.push(ms);
                if (waits.length === 4) controller.abort();
            },
        });

        expect(waits).toEqual([10, 20, 40, 80]);
    });
});
