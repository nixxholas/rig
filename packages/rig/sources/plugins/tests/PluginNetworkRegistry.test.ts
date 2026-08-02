import { describe, expect, it } from "vitest";

import type { HappyNetworkEvent } from "happy-plugins";
import { HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES } from "happy-plugins";
import { PluginNetworkRegistry } from "../PluginNetworkRegistry.js";

describe("PluginNetworkRegistry", () => {
    it("lets the first plugin folder handle and sends later plugins observations only", async () => {
        const registry = new PluginNetworkRegistry();
        const laterEvents: HappyNetworkEvent[] = [];
        const later = registry.createConnection({
            folder: "zeta",
            interceptDomains: ["api.example.com"],
            name: "Zeta",
        });
        const laterId = later.register("request");
        later.attach(laterId, (event) => {
            laterEvents.push(event);
            return true;
        });
        const firstEvents: HappyNetworkEvent[] = [];
        const first = registry.createConnection({
            folder: "alpha",
            interceptDomains: ["api.example.com"],
            name: "Alpha",
        });
        const firstId = first.register("request");
        first.attach(firstId, (event) => {
            firstEvents.push(event);
            if (event.type === "request") {
                first.complete(firstId, event.callId, {
                    status: 204,
                    type: "response",
                });
            }
            return true;
        });

        await expect(
            registry.interceptHttp({
                body: Buffer.alloc(0),
                headers: {},
                hostname: "api.example.com",
                method: "GET",
                url: "http://api.example.com/",
            }),
        ).resolves.toEqual({ status: 204, type: "response" });
        expect(firstEvents).toMatchObject([{ mode: "handle", type: "request" }]);
        expect(laterEvents).toMatchObject([{ mode: "observe", type: "request" }]);

        registry.close();
    });

    it("bounds request events and fails open immediately when a listener applies backpressure", async () => {
        const failures: string[] = [];
        const registry = new PluginNetworkRegistry({
            onFailure: (failure) => failures.push(failure.error),
        });
        const connection = registry.createConnection({
            folder: "bounded",
            interceptDomains: ["api.example.com"],
            name: "Bounded",
        });
        const registrationId = connection.register("request");
        const events: HappyNetworkEvent[] = [];
        connection.attach(registrationId, (event) => {
            events.push(event);
            return false;
        });
        const headers = Object.fromEntries(
            Array.from({ length: 200 }, (_, index) => [
                `x-header-${String(index)}`,
                "v".repeat(9_000),
            ]),
        );

        await expect(
            registry.interceptHttp({
                body: Buffer.alloc(256 * 1024),
                headers,
                hostname: "api.example.com",
                method: "GET",
                url: `http://api.example.com/${"x".repeat(10_000)}`,
            }),
        ).resolves.toEqual({ type: "pass_through" });
        expect(registry.shouldIntercept("api.example.com")).toBe(true);
        expect(events).toHaveLength(1);
        expect(Buffer.byteLength(`${JSON.stringify(events[0])}\n`)).toBeLessThanOrEqual(
            HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES,
        );
        expect(events[0]).toMatchObject({
            headers: expect.objectContaining({ "x-header-0": expect.any(String) }),
            type: "request",
        });
        expect(failures).toEqual([
            "The plugin network handler could not accept the request without buffering.",
        ]);

        registry.close();
    });
});
