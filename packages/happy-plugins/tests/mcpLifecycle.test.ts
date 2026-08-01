import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHappyPluginClient, defineMcpTool, Type } from "../sources/index.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("Happy MCP server lifecycle", () => {
    it("unregisters a registration whose event stream fails to open", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".m-"));
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

    it("unregisters a recovery registration closed after POST but before stream attachment", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".m-"));
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "s");
        const recoveryStreamStarted = deferred<void>();
        const requests: string[] = [];
        let firstStream: ServerResponse | undefined;
        let recoveryStream: ServerResponse | undefined;
        let registration = 0;
        const server = createServer((request, response) => {
            const path = request.url ?? "/";
            requests.push(`${request.method ?? "GET"} ${path}`);
            if (request.method === "POST" && path === "/mcp/servers") {
                registration += 1;
                sendJson(response, 201, {
                    registrationId: `registration-${String(registration)}`,
                });
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
            if (request.method === "GET" && path === "/mcp/servers/registration-2/events") {
                recoveryStream = response;
                recoveryStreamStarted.resolve();
                return;
            }
            if (request.method === "DELETE" && path === "/mcp/servers/registration-2") {
                sendJson(response, 200, {});
                if (recoveryStream !== undefined) {
                    sendJson(recoveryStream, 404, {
                        error: "The unattached registration was removed.",
                    });
                }
                return;
            }
            sendJson(response, 404, { error: "Unexpected test request." });
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        const contribution = await createHappyPluginClient({
            socketPath,
            token: "plugin-token",
        }).mcp.startServer(testServer("Close while opening"));
        expect(contribution.registrationId).toBe("registration-1");

        firstStream!.destroy();
        await recoveryStreamStarted.promise;
        expect(contribution.registrationId).toBe("registration-2");

        await contribution.close();

        expect(contribution.status).toBe("closed");
        expect(
            requests.filter((request) => request === "DELETE /mcp/servers/registration-2"),
        ).toHaveLength(1);
        expect(requests).not.toContain("DELETE /mcp/servers/registration-1");
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

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}
