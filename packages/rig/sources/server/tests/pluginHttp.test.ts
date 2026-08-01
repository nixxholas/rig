import { request as requestHttp } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
    PluginApplicationNotFoundError,
    PluginApplicationStaleGenerationError,
} from "../../plugins/index.js";
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
        const server = createProtocolHttpServer({
            plugins: {
                invokeApplication: async () => {
                    throw new Error("Unused in this test.");
                },
                list: async () => ({
                    failures: [],
                    plugins: [
                        {
                            applications: [],
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
                }),
                readApplicationResource: () => {
                    throw new Error("Unused in this test.");
                },
                readLog: async (name) => ({
                    folder: "clock",
                    name,
                    source: "current_run",
                    status: "stopped",
                    text: "[stdout] tick\n",
                    truncated: false,
                    updatedAt: 42,
                }),
            },
            token: "secret",
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port.");

        await expect(requestJson(address.port, "/plugins")).resolves.toMatchObject({
            plugins: [{ name: "Clock", status: "stopped" }],
        });
        await expect(requestJson(address.port, "/plugins/Clock/log")).resolves.toEqual({
            log: {
                folder: "clock",
                name: "Clock",
                source: "current_run",
                status: "stopped",
                text: "[stdout] tick\n",
                truncated: false,
                updatedAt: 42,
            },
        });
    });

    it("authenticates application resources and actions and rejects stale or traversing paths", async () => {
        const server = createProtocolHttpServer({
            plugins: {
                invokeApplication: async (applicationId, generation, action, input) => {
                    if (generation === "old") throw new PluginApplicationStaleGenerationError();
                    return { action, applicationId, generation, input };
                },
                list: async () => ({
                    failures: [],
                    plugins: [],
                    version: "01900000-0000-7000-8000-000000000001",
                }),
                readApplicationResource: (applicationId, generation, resourcePath) => {
                    if (generation === "old") throw new PluginApplicationStaleGenerationError();
                    if (resourcePath !== "index.html") {
                        throw new PluginApplicationNotFoundError();
                    }
                    expect(applicationId).toBe("usage:overview");
                    return { body: Buffer.from("<h1>Usage</h1>"), mediaType: "text/html" };
                },
                readLog: async () => {
                    throw new Error("Unused in this test.");
                },
            },
            token: "secret",
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port.");

        const unauthorized = await request(address.port, {
            path: applicationResourcePath("current", "index.html"),
            token: "wrong",
        });
        expect(unauthorized.status).toBe(401);

        const resource = await request(address.port, {
            path: applicationResourcePath("current", "index.html"),
        });
        expect(resource).toMatchObject({
            body: "<h1>Usage</h1>",
            status: 200,
        });
        expect(resource.headers["content-security-policy"]).toContain("connect-src 'none'");
        expect(resource.headers["x-content-type-options"]).toBe("nosniff");

        const traversal = await request(address.port, {
            path: applicationResourcePath("current", "%2e%2e%2fsecret"),
        });
        expect(traversal.status).toBe(404);

        const stale = await request(address.port, {
            path: applicationResourcePath("old", "index.html"),
        });
        expect(stale.status).toBe(409);

        const action = await request(address.port, {
            body: JSON.stringify({ input: { scope: "weekly" } }),
            method: "POST",
            path: "/plugin-applications/usage%3Aoverview/generations/current/actions/read",
        });
        expect(JSON.parse(action.body)).toEqual({
            result: {
                action: "read",
                applicationId: "usage:overview",
                generation: "current",
                input: { scope: "weekly" },
            },
        });

        const invalidAction = await request(address.port, {
            body: JSON.stringify({ extra: true, input: {} }),
            method: "POST",
            path: "/plugin-applications/usage%3Aoverview/generations/current/actions/read",
        });
        expect(invalidAction.status).toBe(400);
    });
});

function requestJson(port: number, path: string): Promise<unknown> {
    return request(port, { path }).then((response) => JSON.parse(response.body) as unknown);
}

function applicationResourcePath(generation: string, resource: string): string {
    return `/plugin-applications/usage%3Aoverview/generations/${generation}/resources/${resource}`;
}

function request(
    port: number,
    options: {
        body?: string;
        method?: string;
        path: string;
        token?: string;
    },
): Promise<{
    body: string;
    headers: Record<string, string | string[] | undefined>;
    status: number;
}> {
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
                response.once("end", () => {
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 500,
                    });
                });
            },
        );
        request.once("error", reject);
        request.end(options.body);
    });
}
