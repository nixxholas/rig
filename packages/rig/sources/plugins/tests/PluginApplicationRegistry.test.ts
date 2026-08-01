import { describe, expect, it, vi } from "vitest";

import type {
    HappyPluginApplicationEvent,
    HappyPluginApplicationRegistration,
} from "happy-plugins";
import { HAPPY_PLUGIN_MAX_RESOURCE_BYTES } from "happy-plugins";

import {
    PluginApplicationActionError,
    PluginApplicationRegistry,
    PluginApplicationStaleGenerationError,
} from "../PluginApplicationRegistry.js";

describe("PluginApplicationRegistry", () => {
    it("publishes attached applications in deterministic navigation order and serves resources", () => {
        const registry = new PluginApplicationRegistry();
        const changed = vi.fn();
        registry.subscribe(changed);
        const connection = registry.createConnection({ folder: "usage", name: "Usage" });
        const later = connection.register(application("details", 20, "Details"));
        const first = connection.register(application("overview", 10, "Overview"));

        expect(registry.list()).toEqual([]);
        connection.attach(later.registrationId, () => true);
        connection.attach(first.registrationId, () => true);

        expect(registry.list().map((item) => item.id)).toEqual(["usage:overview", "usage:details"]);
        expect(registry.list()[0]).toMatchObject({
            applicationId: "overview",
            generation: first.generation,
            navigation: { label: "Overview", order: 10 },
            pluginFolder: "usage",
            resources: [{ mediaType: "text/html", path: "index.html", size: 14 }],
        });
        expect(
            registry.readResource("usage:overview", first.generation, "index.html"),
        ).toMatchObject({
            mediaType: "text/html",
        });
        expect(
            registry
                .readResource("usage:overview", first.generation, "index.html")
                .body.toString("utf8"),
        ).toBe("<h1>Usage</h1>");
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it("forwards actions, cancels pending work, and rejects stale replacement generations", async () => {
        const registry = new PluginApplicationRegistry();
        const firstOwner = registry.createConnection({ folder: "usage", name: "Usage" });
        const first = firstOwner.register(application("overview", 10, "Usage", ["read"]));
        const events: HappyPluginApplicationEvent[] = [];
        firstOwner.attach(first.registrationId, (event) => {
            events.push(event);
            return true;
        });

        const action = registry.invoke("usage:overview", first.generation, "read", {
            account: "codex",
        });
        const request = events[0];
        expect(request).toMatchObject({
            action: "read",
            input: { account: "codex" },
            type: "request",
        });
        if (request?.type !== "request") throw new Error("Missing application action request.");
        firstOwner.complete(first.registrationId, request.requestId, {
            result: { usedPercent: 42 },
        });
        await expect(action).resolves.toEqual({ usedPercent: 42 });

        const pending = registry.invoke("usage:overview", first.generation, "read", {});
        firstOwner.close();
        await expect(pending).rejects.toThrow("stopped");
        expect(registry.list()).toEqual([]);

        const replacement = registry.createConnection({ folder: "usage", name: "Usage" });
        const next = replacement.register(application("overview", 10, "Usage", ["read"]));
        replacement.attach(next.registrationId, () => true);
        expect(next.generation).not.toBe(first.generation);
        expect(() =>
            registry.readResource("usage:overview", first.generation, "index.html"),
        ).toThrow(PluginApplicationStaleGenerationError);
        await expect(
            registry.invoke("usage:overview", first.generation, "read", {}),
        ).rejects.toBeInstanceOf(PluginApplicationStaleGenerationError);
    });

    it("rejects invalid, duplicate, oversized, and disconnected contributions", async () => {
        const registry = new PluginApplicationRegistry({ actionTimeoutMs: 10 });
        const owner = registry.createConnection({ folder: "usage", name: "Usage" });

        expect(() =>
            owner.register({
                ...application("overview", 10, "Usage"),
                entry: "../index.html",
            }),
        ).toThrow();
        expect(() =>
            owner.register({
                ...application("overview", 10, "Usage"),
                resources: [
                    {
                        body: "x".repeat(HAPPY_PLUGIN_MAX_RESOURCE_BYTES + 1),
                        encoding: "utf8",
                        mediaType: "text/html",
                        path: "index.html",
                    },
                ],
            }),
        ).toThrow("larger than");
        expect(() =>
            owner.register({
                ...application("overview", 10, "Usage"),
                resources: [
                    {
                        body: "not base64!",
                        encoding: "base64",
                        mediaType: "text/html",
                        path: "index.html",
                    },
                ],
            }),
        ).toThrow("not valid base64");

        const registered = owner.register(application("overview", 10, "Usage", ["read"]));
        expect(() => owner.register(application("overview", 20, "Again"))).toThrow(
            "already registered",
        );
        owner.attach(registered.registrationId, () => {
            throw new Error("Disconnected.");
        });
        await expect(
            registry.invoke("usage:overview", registered.generation, "read", {}),
        ).rejects.toBeInstanceOf(PluginApplicationActionError);
    });

    it("bounds concurrent actions per application", async () => {
        const registry = new PluginApplicationRegistry({ actionTimeoutMs: 60_000 });
        const owner = registry.createConnection({ folder: "catalog", name: "Catalog" });
        const registered = owner.register(application("overview", 10, "Catalog", ["read"]));
        owner.attach(registered.registrationId, () => undefined);
        const pending = Array.from({ length: 64 }, () =>
            registry.invoke("catalog:overview", registered.generation, "read", {}),
        );

        await expect(
            registry.invoke("catalog:overview", registered.generation, "read", {}),
        ).rejects.toThrow("64 actions in progress");
        registry.close();
        await Promise.allSettled(pending);
    });
});

function application(
    id: string,
    order: number,
    label: string,
    actions: readonly string[] = [],
): HappyPluginApplicationRegistration {
    return {
        actions: [...actions],
        entry: "index.html",
        id,
        navigation: { label, order },
        resources: [
            {
                body: "<h1>Usage</h1>",
                encoding: "utf8",
                mediaType: "text/html",
                path: "index.html",
            },
        ],
        title: label,
    };
}
