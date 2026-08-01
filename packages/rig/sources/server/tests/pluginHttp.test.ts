import { request as requestHttp } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { PluginAppError } from "../../plugins/index.js";
import type { PluginContext } from "../../agent/context/PluginContext.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const servers: ReturnType<typeof createProtocolHttpServer>[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeAllConnections();
                }),
        ),
    );
});

describe("plugin HTTP protocol", () => {
    it("serves explicit plugin states and bounded current logs", async () => {
        const plugins = context();
        const server = createProtocolHttpServer({ plugins, token: "secret" });
        servers.push(server);
        const port = await listen(server);
        await expect(requestJson(port, "/plugins")).resolves.toMatchObject({
            plugins: [{ name: "Clock", status: "stopped" }],
        });
        await expect(requestJson(port, "/plugins/Clock/log")).resolves.toMatchObject({
            log: { name: "Clock", text: "[stdout] tick\n" },
        });
    });

    it("authenticates MCP App resources, tools, and namespaced storage and closes stale errors", async () => {
        const plugins = context();
        const server = createProtocolHttpServer({ plugins, token: "secret" });
        servers.push(server);
        const port = await listen(server);
        const base = "/plugin-apps/usage%3Aoverview/generations/current";

        expect(
            (
                await request(port, {
                    body: JSON.stringify({ uri: "ui://usage/overview/index.html" }),
                    method: "POST",
                    path: `${base}/resources/read`,
                    token: "wrong",
                })
            ).status,
        ).toBe(401);
        await expect(
            requestJson(port, `${base}/resources/read`, {
                uri: "ui://usage/overview/index.html",
            }),
        ).resolves.toEqual({
            contents: [
                {
                    mimeType: "text/html;profile=mcp-app",
                    text: "<h1>Usage</h1>",
                    uri: "ui://usage/overview/index.html",
                },
            ],
        });
        await expect(
            requestJson(port, `${base}/tools/call`, {
                arguments: { scope: "weekly" },
                name: "read",
                server: "Usage",
            }),
        ).resolves.toMatchObject({ result: { content: [{ text: "read weekly" }] } });
        await expect(
            requestJson(port, `${base}/extensions/io.slopus.happy/storage/set`, {
                key: "layout",
                value: { compact: true },
            }),
        ).resolves.toEqual({});
        expect(
            (
                await request(port, {
                    body: JSON.stringify({ uri: "ui://usage/overview/index.html" }),
                    method: "POST",
                    path: "/plugin-apps/usage%3Aoverview/generations/old/resources/read",
                })
            ).status,
        ).toBe(409);
    });
});

function context(): Pick<
    PluginContext,
    | "callAppTool"
    | "list"
    | "readAppResource"
    | "readLog"
    | "storageDelete"
    | "storageGet"
    | "storageList"
    | "storageSet"
> {
    return {
        async callAppTool(_id, generation, _server, tool, input) {
            if (generation === "old")
                throw new PluginAppError("stale_generation", "stale generation");
            return {
                content: [
                    {
                        text: `${tool} ${(input as { scope?: string }).scope ?? ""}`.trim(),
                        type: "text",
                    },
                ],
            };
        },
        async list() {
            return {
                failures: [],
                plugins: [
                    {
                        apps: [],
                        dataDirectory: "/data/clock",
                        description: "A clock.",
                        directory: "/plugins/clock",
                        folder: "clock",
                        logAvailable: true,
                        name: "Clock",
                        status: "stopped",
                    },
                ],
                version: "01900000-0000-7000-8000-000000000001",
            };
        },
        readAppResource(_id, generation, uri) {
            if (generation === "old")
                throw new PluginAppError("stale_generation", "stale generation");
            return { mimeType: "text/html;profile=mcp-app", text: "<h1>Usage</h1>", uri };
        },
        async readLog(name) {
            return {
                folder: "clock",
                name,
                source: "current_run",
                status: "stopped",
                text: "[stdout] tick\n",
                truncated: false,
                updatedAt: 42,
            };
        },
        async storageDelete() {},
        async storageGet() {
            return undefined;
        },
        async storageList() {
            return [];
        },
        async storageSet() {},
    };
}

async function listen(server: ReturnType<typeof createProtocolHttpServer>): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    return address.port;
}

function requestJson(port: number, path: string, body?: unknown): Promise<unknown> {
    return request(port, {
        ...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
        path,
    }).then((response) => JSON.parse(response.body) as unknown);
}

function request(
    port: number,
    options: { body?: string; method?: string; path: string; token?: string },
): Promise<{ body: string; status: number }> {
    return new Promise((resolve, reject) => {
        const request = requestHttp(
            {
                headers: {
                    authorization: `Bearer ${options.token ?? "secret"}`,
                    ...(options.body === undefined
                        ? {}
                        : {
                              "content-length": String(Buffer.byteLength(options.body)),
                              "content-type": "application/json",
                          }),
                },
                host: "127.0.0.1",
                method: options.method ?? "GET",
                path: options.path,
                port,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        status: response.statusCode ?? 500,
                    }),
                );
            },
        );
        request.once("error", reject);
        request.end(options.body);
    });
}
