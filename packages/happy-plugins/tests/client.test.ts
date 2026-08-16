import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    createHappyPluginClient,
    HappyPluginApiError,
    HAPPY_PLUGIN_MAX_FILE_BYTES,
} from "../sources/index.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("happy-plugins client", () => {
    it("reports readiness through an explicit startup declaration", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugins-client-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "s");
        const server = createServer((request, response) => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("/ready");
            response.end("{}");
        });
        servers.push(server);
        await listen(server, socketPath);

        await expect(
            createHappyPluginClient({ socketPath, token: "plugin-token" }).ready("Ready."),
        ).resolves.toBeUndefined();
    });

    it("authenticates over the provided Unix socket and validates the response schema", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugins-client-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "s");
        const server = createServer((request, response) => {
            expect(request.headers.authorization).toBe("Bearer plugin-token");
            expect(request.method).toBe("GET");
            expect(request.url).toBe("/projects");
            const body = JSON.stringify({
                projects: [{ id: "project-1", name: "Happy", path: "/workspace" }],
            });
            response.writeHead(200, {
                "content-length": Buffer.byteLength(body),
                "content-type": "application/json",
            });
            response.end(body);
        });
        servers.push(server);
        await listen(server, socketPath);

        const client = createHappyPluginClient({ socketPath, token: "plugin-token" });
        await expect(client.projects.list()).resolves.toEqual([
            { id: "project-1", name: "Happy", path: "/workspace" },
        ]);
    });

    it("rejects invalid daemon responses through the TypeBox schema", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugins-client-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "s");
        const server = createServer((_request, response) => {
            response.end(JSON.stringify({ projects: [{ name: "Missing fields" }] }));
        });
        servers.push(server);
        await listen(server, socketPath);

        const client = createHappyPluginClient({ socketPath, token: "plugin-token" });
        await expect(client.projects.list()).rejects.toThrow();
    });

    it("reads provider-neutral usage for application actions", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugins-client-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "s");
        const server = createServer((request, response) => {
            expect(request.url).toBe("/provider-usage");
            response.end(
                JSON.stringify({
                    providers: [
                        {
                            checkedAt: 42,
                            error: null,
                            providerId: "codex-work",
                            usage: {
                                capturedAt: 40,
                                credits: null,
                                exhausted: false,
                                planName: "Team",
                                providerId: "codex-work",
                                vendor: "codex",
                                windows: {
                                    fiveHour: {
                                        durationMs: 18_000_000,
                                        resetsAt: 100,
                                        startsAt: 0,
                                        usedPercent: 25,
                                    },
                                    monthly: null,
                                    weekly: null,
                                },
                            },
                        },
                    ],
                }),
            );
        });
        servers.push(server);
        await listen(server, socketPath);

        await expect(
            createHappyPluginClient({ socketPath, token: "plugin-token" }).providers.usage(),
        ).resolves.toMatchObject([{ providerId: "codex-work", usage: { vendor: "codex" } }]);
    });

    it("surfaces daemon errors and missing injected settings in human language", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugins-client-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "s");
        const server = createServer((_request, response) => {
            response.writeHead(409);
            response.end(JSON.stringify({ error: "The workspace already exists." }));
        });
        servers.push(server);
        await listen(server, socketPath);

        const client = createHappyPluginClient({ socketPath, token: "plugin-token" });
        await expect(client.projects.list()).rejects.toEqual(
            new HappyPluginApiError(409, "The workspace already exists."),
        );
        await expect(
            createHappyPluginClient({ socketPath: "", token: "" }).projects.list(),
        ).rejects.toThrow("HAPPY_PLUGIN_SOCKET_PATH");
    });

    it("rejects workspace file content over the UTF-8 byte limit before sending", async () => {
        const client = createHappyPluginClient({
            socketPath: "/unused/plugin.sock",
            token: "plugin-token",
        });
        await expect(
            client.workspaces.files.write({
                content: "€".repeat(Math.floor(HAPPY_PLUGIN_MAX_FILE_BYTES / 2)),
                path: "report.txt",
                workspaceId: "workspace-1",
            }),
        ).rejects.toThrow(
            `Workspace file content cannot exceed ${String(HAPPY_PLUGIN_MAX_FILE_BYTES)} UTF-8 bytes.`,
        );
    });

    it("does not retain finite connections across clients or daemon restarts", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugins-client-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "s");
        const activeConnections = new Set<object>();
        let connectionCount = 0;
        const createProjectServer = () => {
            const server = createServer((_request, response) => {
                const body = JSON.stringify({ projects: [] });
                response.writeHead(200, {
                    "content-length": Buffer.byteLength(body),
                    "content-type": "application/json",
                });
                response.end(body);
            });
            server.on("connection", (socket) => {
                connectionCount += 1;
                activeConnections.add(socket);
                socket.once("close", () => activeConnections.delete(socket));
            });
            servers.push(server);
            return server;
        };
        let server = createProjectServer();
        await listen(server, socketPath);
        const firstClient = createHappyPluginClient({ socketPath, token: "plugin-token" });
        const secondClient = createHappyPluginClient({ socketPath, token: "plugin-token" });

        await firstClient.projects.list();
        await secondClient.projects.list();
        await closeServer(server);
        await rm(socketPath, { force: true });
        server = createProjectServer();
        await listen(server, socketPath);
        await firstClient.projects.list();

        expect(connectionCount).toBe(3);
        await expect.poll(() => activeConnections.size).toBe(0);
    });
});

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
