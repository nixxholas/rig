import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHappyPluginClient, defineMcpTool, Type } from "../sources/index.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("Happy MCP server lifecycle", () => {
    it("unregisters a registration whose event stream fails to open", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugin-mcp-"));
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "s");
        const requests: string[] = [];
        const server = createServer((request, response) => {
            const path = request.url ?? "/";
            requests.push(`${request.method ?? "GET"} ${path}`);
            if (request.method === "POST" && path === "/mcp/servers") {
                sendJson(response, 201, { registrationId: "registration-1" });
                return;
            }
            if (request.method === "GET" && path === "/mcp/servers/registration-1/events") {
                sendJson(response, 503, { error: "The event stream is unavailable." });
                return;
            }
            if (request.method === "DELETE" && path === "/mcp/servers/registration-1") {
                sendJson(response, 200, {});
                return;
            }
            sendJson(response, 404, { error: "Unexpected test request." });
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        await expect(
            createHappyPluginClient({ socketPath, token: "plugin-token" }).mcp.startServer(
                testServer("Open failure"),
            ),
        ).rejects.toThrow("HTTP 503");

        expect(requests).toEqual([
            "POST /mcp/servers",
            "GET /mcp/servers/registration-1/events",
            "DELETE /mcp/servers/registration-1",
        ]);
    });

    it("closes its event stream without retaining finite request connections", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugin-mcp-"));
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "s");
        const activeConnections = new Set<object>();
        let connectionCount = 0;
        const requests: string[] = [];
        const server = createServer((request, response) => {
            const path = request.url ?? "/";
            requests.push(`${request.method ?? "GET"} ${path}`);
            if (request.method === "POST" && path === "/mcp/servers") {
                sendJson(response, 201, { registrationId: "registration-1" });
                return;
            }
            if (request.method === "GET" && path === "/mcp/servers/registration-1/events") {
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                return;
            }
            if (request.method === "GET" && path === "/projects") {
                sendJson(response, 200, { projects: [] });
                return;
            }
            if (request.method === "DELETE" && path === "/mcp/servers/registration-1") {
                sendJson(response, 200, {});
                return;
            }
            sendJson(response, 404, { error: "Unexpected test request." });
        });
        server.on("connection", (socket) => {
            connectionCount += 1;
            activeConnections.add(socket);
            socket.once("close", () => activeConnections.delete(socket));
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);
        const client = createHappyPluginClient({ socketPath, token: "plugin-token" });

        const contribution = await client.mcp.startServer(testServer("Connection ownership"));
        await expect(client.projects.list()).resolves.toEqual([]);
        await contribution.close();

        expect(requests).toEqual([
            "POST /mcp/servers",
            "GET /mcp/servers/registration-1/events",
            "GET /projects",
            "DELETE /mcp/servers/registration-1",
        ]);
        expect(connectionCount).toBe(4);
        await expect.poll(() => activeConnections.size).toBe(0);
    });

    it("does not register a late replacement after its declared stream closes", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugin-mcp-"));
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "s");
        let firstStream: ServerResponse | undefined;
        const requests: string[] = [];
        const server = createServer((request, response) => {
            const path = request.url ?? "/";
            requests.push(`${request.method ?? "GET"} ${path}`);
            if (request.method === "POST" && path === "/mcp/servers") {
                sendJson(response, 201, { registrationId: "registration-1" });
                return;
            }
            if (request.method === "GET" && path === "/mcp/servers/registration-1/events") {
                firstStream = response;
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                return;
            }
            sendJson(response, 404, { error: "Unexpected test request." });
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        const contribution = await createHappyPluginClient({
            socketPath,
            token: "plugin-token",
        }).mcp.startServer(testServer("Synchronous registration"));
        firstStream!.end();
        await expect.poll(() => contribution.status).toBe("closed");
        await contribution.close();

        expect(requests).toEqual(["POST /mcp/servers", "GET /mcp/servers/registration-1/events"]);
    });
});

function testServer(name: string) {
    return {
        name,
        tools: [
            defineMcpTool({
                description: "Return a test result.",
                inputSchema: Type.Object({}),
                name: "ping",
                execute: () => ({ content: [{ text: "pong", type: "text" as const }] }),
            }),
        ],
    };
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function closeServer(server: Server): Promise<void> {
    if (!server.listening) {
        server.closeAllConnections();
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
    });
    response.end(body);
}
