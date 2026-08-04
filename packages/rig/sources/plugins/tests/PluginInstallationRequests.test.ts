import { describe, expect, it, vi } from "vitest";

import type { InstalledPlugin } from "../installPluginFromPath.js";
import { PluginInstallationRequests } from "../PluginInstallationRequests.js";

const installed: InstalledPlugin = {
    classification: "fresh-install",
    description: "A clock.",
    directory: "/managed/clock",
    folder: "clock",
    name: "Clock",
    version: "1.2.0",
};

describe("plugin installation request identity", () => {
    it("joins concurrent retries, replays success, and rejects identity reuse for another source", async () => {
        const requests = new PluginInstallationRequests();
        let resolve!: (value: InstalledPlugin) => void;
        const install = vi.fn(
            () =>
                new Promise<InstalledPlugin>((completed) => {
                    resolve = completed;
                }),
        );

        const first = requests.run("request-1", "source-a", install);
        const retry = requests.run("request-1", "source-a", install);
        expect(first).toBe(retry);
        expect(install).toHaveBeenCalledTimes(1);
        expect(() => requests.run("request-1", "source-b", install)).toThrow(
            "already belongs to a different source",
        );

        resolve(installed);
        await expect(first).resolves.toBe(installed);
        await expect(requests.run("request-1", "source-a", install)).resolves.toBe(installed);
        expect(install).toHaveBeenCalledTimes(1);
    });

    it("recognizes the same package source however its retry ordered the JSON keys", async () => {
        const requests = new PluginInstallationRequests();
        const install = vi.fn(async () => installed);
        const plugin = {
            description: "A small clock.",
            displayName: "Clock",
            name: "clock",
            path: "plugins/clock",
            version: "1.2.0",
        };
        const source = {
            catalogId: "a".repeat(64),
            plugin,
            repository: "happy-dev/plugins",
            revision: "b".repeat(40),
            type: "github",
        };
        const reordered = {
            revision: source.revision,
            type: source.type,
            plugin: {
                version: plugin.version,
                path: plugin.path,
                name: plugin.name,
                displayName: plugin.displayName,
                description: plugin.description,
            },
            repository: source.repository,
            catalogId: source.catalogId,
        };

        await expect(requests.run("request-1", source, install)).resolves.toBe(installed);
        await expect(requests.run("request-1", reordered, install)).resolves.toBe(installed);
        expect(install).toHaveBeenCalledTimes(1);

        expect(() =>
            requests.run("request-1", { ...source, revision: "c".repeat(40) }, install),
        ).toThrow("already belongs to a different source");
    });

    it("allows the same request to restart after an aborted or failed attempt", async () => {
        const requests = new PluginInstallationRequests();
        const install = vi
            .fn<() => Promise<InstalledPlugin>>()
            .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))
            .mockResolvedValueOnce(installed);

        await expect(requests.run("request-1", "source-a", install)).rejects.toMatchObject({
            name: "AbortError",
        });
        await expect(requests.run("request-1", "source-a", install)).resolves.toBe(installed);
        expect(install).toHaveBeenCalledTimes(2);
    });

    it("never evicts an in-flight request to make room for duplicate work", () => {
        const requests = new PluginInstallationRequests();
        const install = () => new Promise<InstalledPlugin>(() => {});
        for (let index = 0; index < 256; index += 1) {
            requests.run(`request-${String(index)}`, `source-${String(index)}`, install);
        }
        expect(() => requests.run("request-over-limit", "source", install)).toThrow(
            "maximum number of retained plugin installation requests",
        );
    });
});
