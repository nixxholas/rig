import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PluginAppError, PluginAppRegistry } from "../PluginAppRegistry.js";
import { PluginMcpRegistry } from "../PluginMcpRegistry.js";
import type { PluginRuntimeSnapshot } from "../types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("PluginAppRegistry", () => {
    it("publishes static apps with every MCP tool attached during startup", async () => {
        const root = await temporaryRoot();
        const mcp = new PluginMcpRegistry();
        const registry = new PluginAppRegistry(mcp);
        const connection = mcp.createConnection({ folder: "usage", name: "Usage" });
        const registration = connection.register({ name: "Usage", tools: [tool("read", ["app"])] });
        connection.attach(registration, () => true);
        registry.register(plugin(), connection.generation, root);
        expect(registry.list()).toMatchObject([
            { appId: "usage", tools: [{ name: "read", server: "Usage" }] },
        ]);
    });

    it("publishes an official MCP App resource and app-visible tools for one generation", async () => {
        const root = await temporaryRoot();
        const mcp = new PluginMcpRegistry();
        const registry = new PluginAppRegistry(mcp);
        const connection = mcp.createConnection({ folder: "usage", name: "Usage" });
        const registrationId = connection.register({
            name: "Usage",
            tools: [
                tool("model_only", ["model"]),
                tool("read_usage", ["model", "app"]),
                tool("refresh", ["app"]),
            ],
        });
        const calls: unknown[] = [];
        connection.attach(registrationId, (event) => {
            calls.push(event);
            if (event.type === "call") {
                connection.complete(registrationId, event.callId, {
                    result: { content: [{ text: "ok", type: "text" }] },
                });
            }
            return true;
        });
        registry.register(plugin(), connection.generation, root);

        expect(registry.list()).toMatchObject([
            {
                appId: "usage",
                resourceUri: "ui://usage/usage/index.html",
                resources: [
                    {
                        mimeType: "text/html;profile=mcp-app",
                        uri: "ui://usage/usage/index.html",
                    },
                ],
                tools: [
                    { name: "read_usage", server: "Usage" },
                    { name: "refresh", server: "Usage" },
                ],
            },
        ]);
        expect(
            registry.readResource(
                "usage:usage",
                connection.generation,
                "ui://usage/usage/index.html",
            ),
        ).toEqual({
            mimeType: "text/html;profile=mcp-app",
            text: "<h1>Usage</h1>",
            uri: "ui://usage/usage/index.html",
        });
        await expect(
            registry.callTool("usage:usage", connection.generation, "Usage", "refresh", {}),
        ).resolves.toMatchObject({ content: [{ text: "ok" }] });
        expect(calls).toHaveLength(1);
        await expect(
            registry.callTool("usage:usage", connection.generation, "Usage", "model_only", {}),
        ).rejects.toMatchObject({ code: "tool_not_found" });
    });

    it("fails stale generations closed", async () => {
        const root = await temporaryRoot();
        const mcp = new PluginMcpRegistry();
        const registry = new PluginAppRegistry(mcp);
        const connection = mcp.createConnection({ folder: "usage", name: "Usage" });
        const unregister = registry.register(plugin(), connection.generation, root);
        unregister();
        expect(() =>
            registry.readResource(
                "usage:usage",
                connection.generation,
                "ui://usage/usage/index.html",
            ),
        ).toThrow(PluginAppError);
    });

    it("maps the typed MCP timeout without inspecting error text", async () => {
        const root = await temporaryRoot();
        const mcp = new PluginMcpRegistry({ callTimeoutMs: 5 });
        const registry = new PluginAppRegistry(mcp);
        const connection = mcp.createConnection({ folder: "usage", name: "Usage" });
        const registration = connection.register({
            name: "Usage",
            tools: [tool("slow", ["app"])],
        });
        connection.attach(registration, () => true);
        registry.register(plugin(), connection.generation, root);
        await expect(
            registry.callTool("usage:usage", connection.generation, "Usage", "slow", {}),
        ).rejects.toMatchObject({ code: "timeout" });
    });

    it("persists atomic JSON storage and rejects an over-quota replacement without data loss", async () => {
        const root = await temporaryRoot();
        const mcp = new PluginMcpRegistry();
        const registry = new PluginAppRegistry(mcp);
        const connection = mcp.createConnection({ folder: "usage", name: "Usage" });
        registry.register(plugin(), connection.generation, root);

        await registry.storageSet("usage:usage", connection.generation, "layout", {
            compact: true,
        });
        await expect(
            registry.storageGet("usage:usage", connection.generation, "layout"),
        ).resolves.toEqual({ compact: true });
        await expect(registry.storageList("usage:usage", connection.generation)).resolves.toEqual([
            "layout",
        ]);
        await expect(
            registry.storageSet(
                "usage:usage",
                connection.generation,
                "layout",
                "x".repeat(70 * 1024),
            ),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(readFile(join(root, "storage", "layout.json"), "utf8")).resolves.toBe(
            '{"compact":true}\n',
        );
        await registry.storageDelete("usage:usage", connection.generation, "layout");
        const fullValue = "x".repeat(64 * 1024 - 4);
        for (let index = 0; index < 80; index += 1) {
            await registry.storageSet(
                "usage:usage",
                connection.generation,
                `item-${String(index).padStart(2, "0")}`,
                fullValue,
            );
        }
        await expect(
            registry.storageSet("usage:usage", connection.generation, "overflow", fullValue),
        ).rejects.toMatchObject({ code: "storage_full" });
        await expect(
            registry.storageGet("usage:usage", connection.generation, "overflow"),
        ).resolves.toBeUndefined();

        const restarted = new PluginAppRegistry(mcp);
        restarted.register(plugin(), connection.generation, root);
        await expect(
            restarted.storageGet("usage:usage", connection.generation, "item-00"),
        ).resolves.toBe(fullValue);
    });

    it("bounds key count, removes crash temporaries, and maps corrupt JSON", async () => {
        const root = await temporaryRoot();
        const mcp = new PluginMcpRegistry();
        const registry = new PluginAppRegistry(mcp);
        const connection = mcp.createConnection({ folder: "usage", name: "Usage" });
        registry.register(plugin(), connection.generation, root);
        const storage = join(root, "storage");
        await mkdir(storage);
        await writeFile(join(storage, ".layout.crash.tmp"), "partial");
        await writeFile(join(storage, "broken.json"), "{");
        await expect(
            registry.storageGet("usage:usage", connection.generation, "broken"),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await rm(join(storage, "broken.json"));
        for (let index = 0; index < 1_024; index += 1) {
            await writeFile(join(storage, `key-${String(index).padStart(4, "0")}.json`), "null\n");
        }
        await expect(
            registry.storageList("usage:usage", connection.generation),
        ).resolves.toHaveLength(1_024);
        expect(await readdir(storage)).not.toContain(".layout.crash.tmp");
        await expect(
            registry.storageSet("usage:usage", connection.generation, "overflow", null),
        ).rejects.toMatchObject({ code: "storage_full" });
    });
});

function tool(name: string, visibility: ("app" | "model")[]) {
    return {
        _meta: { ui: { visibility } },
        description: `${name} description`,
        inputSchema: { additionalProperties: false, properties: {}, type: "object" as const },
        name,
    };
}

function plugin(): PluginRuntimeSnapshot {
    return {
        apps: [
            {
                id: "usage",
                page: "index.html",
                resourceUri: "ui://usage/usage/index.html",
                resources: [
                    {
                        body: Buffer.from("<h1>Usage</h1>"),
                        mediaType: "text/html",
                        path: "index.html",
                    },
                ],
                sidebar: { label: "Usage", order: 10 },
                title: "Usage",
            },
        ],
        directory: "/plugin",
        entryPath: "/plugin/index.ts",
        folderName: "usage",
        iconPath: "/plugin/icon.png",
        manifest: {
            apps: [
                {
                    id: "usage",
                    page: "index.html",
                    root: "app",
                    sidebar: { label: "Usage", order: 10 },
                    title: "Usage",
                },
            ],
            description: "Usage",
            icon: "icon.png",
            main: "index.ts",
            name: "Usage",
            version: "0.0.0",
        },
        manifestPath: "/plugin/happy.plugin.json",
    };
}

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-app-storage-"));
    roots.push(root);
    return root;
}
