import { afterEach, describe, expect, it, vi } from "vitest";

import type { HealthResponse, ReadyHealthResponse } from "../protocol/index.js";
import { ProtocolHttpClient } from "./ProtocolHttpClient.js";
import { waitForReady } from "./ensureLocalProtocolServer.js";

describe("waitForReady", () => {
    afterEach(() => vi.useRealTimers());

    it("recovers from one stalled health poll after observing startup", async () => {
        vi.useFakeTimers();
        const identity = { version: "test" };
        const starting: HealthResponse = {
            healthy: true,
            identity,
            protocolVersion: 1,
            ready: false,
            status: "starting",
        };
        const ready: ReadyHealthResponse = {
            catalog: {
                defaultModelId: "test-model",
                defaultProviderId: "test-provider",
                models: [],
                providers: [],
            },
            durableGlobalEventQueue: false,
            healthy: true,
            identity,
            protocolVersion: 1,
            ready: true,
            status: "ready",
        };
        const health = vi
            .fn<ProtocolHttpClient["health"]>()
            .mockResolvedValueOnce(starting)
            .mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error("Health poll stalled.")), 6_000);
                    }),
            )
            .mockResolvedValue(ready);
        const client = { health } as unknown as ProtocolHttpClient;

        const result = expect(waitForReady(client)).resolves.toBe(ready);
        await vi.advanceTimersByTimeAsync(7_000);

        await result;
        expect(health).toHaveBeenCalledTimes(3);
    });
});
