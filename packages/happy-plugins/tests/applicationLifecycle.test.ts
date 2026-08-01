import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    createHappyPluginClient,
    defineHappyPluginApplicationAction,
    Type,
} from "../sources/index.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("Happy plugin application lifecycle", () => {
    it("registers bounded resources, executes typed actions, and closes its stream", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".a-"));
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "s");
        const completion = deferred<unknown>();
        let actionStream: ServerResponse | undefined;
        let registered: unknown;
        const server = createServer((request, response) => {
            const path = request.url ?? "/";
            if (request.method === "POST" && path === "/ui/applications") {
                void readJson(request).then((value) => {
                    registered = value;
                    sendJson(response, 201, {
                        generation: "process-generation",
                        registrationId: "application-registration",
                    });
                });
                return;
            }
            if (
                request.method === "GET" &&
                path === "/ui/applications/application-registration/events"
            ) {
                actionStream = response;
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                return;
            }
            if (
                request.method === "POST" &&
                path === "/ui/applications/application-registration/actions/request-1"
            ) {
                void readJson(request).then((value) => {
                    completion.resolve(value);
                    sendJson(response, 200, {});
                });
                return;
            }
            sendJson(response, 404, { error: "Unexpected test request." });
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        const application = await createHappyPluginClient({
            socketPath,
            token: "plugin-token",
        }).ui.startApplication({
            actions: [
                defineHappyPluginApplicationAction({
                    execute: ({ scope }) => ({ scope, usedPercent: 42 }),
                    inputSchema: Type.Object({ scope: Type.String() }),
                    name: "read",
                    outputSchema: Type.Object({
                        scope: Type.String(),
                        usedPercent: Type.Number(),
                    }),
                }),
            ],
            entry: "index.html",
            id: "overview",
            navigation: { label: "Usage", order: 10 },
            resources: [
                {
                    body: "<h1>Usage</h1>",
                    encoding: "utf8",
                    mediaType: "text/html",
                    path: "index.html",
                },
            ],
            title: "Usage",
        });

        expect(application).toMatchObject({
            generation: "process-generation",
            id: "overview",
            registrationId: "application-registration",
            status: "connected",
        });
        expect(registered).toMatchObject({
            actions: ["read"],
            entry: "index.html",
            id: "overview",
            resources: [{ path: "index.html" }],
        });

        actionStream!.write(
            `${JSON.stringify({
                action: "read",
                input: { scope: "weekly" },
                requestId: "request-1",
                type: "request",
            })}\n`,
        );
        await expect(completion.promise).resolves.toEqual({
            result: { scope: "weekly", usedPercent: 42 },
        });

        await application.close();
        expect(application.status).toBe("closed");
    });

    it("rejects traversal, missing entry resources, and oversized resource bytes locally", async () => {
        const client = createHappyPluginClient({ socketPath: "/unused", token: "unused" });
        const base = {
            entry: "index.html",
            id: "overview",
            navigation: { label: "Usage", order: 10 },
            resources: [
                {
                    body: "<h1>Usage</h1>",
                    encoding: "utf8" as const,
                    mediaType: "text/html" as const,
                    path: "index.html",
                },
            ],
            title: "Usage",
        };

        await expect(
            client.ui.startApplication({ ...base, entry: "../index.html" }),
        ).rejects.toThrow();
        await expect(
            client.ui.startApplication({ ...base, entry: "missing.html" }),
        ).rejects.toThrow("entry");
        await expect(
            client.ui.startApplication({
                ...base,
                resources: [
                    {
                        ...base.resources[0]!,
                        body: "x".repeat(256 * 1024 + 1),
                    },
                ],
            }),
        ).rejects.toThrow("larger than");
    });
});

function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("error", reject);
        request.once("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
            } catch (error) {
                reject(error);
            }
        });
    });
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}
