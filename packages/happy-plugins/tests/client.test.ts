import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHappyPluginClient, HappyPluginApiError } from "../sources/index.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

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
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("happy-plugins client", () => {
    it("authenticates over the provided Unix socket and validates the response schema", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".happy-plugin-sdk-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "api.sock");
        const server = createServer((request, response) => {
            expect(request.headers.authorization).toBe("Bearer extension-token");
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

        const client = createHappyPluginClient({ socketPath, token: "extension-token" });
        await expect(client.projects.list()).resolves.toEqual([
            { id: "project-1", name: "Happy", path: "/workspace" },
        ]);
    });

    it("rejects invalid daemon responses through the TypeBox schema", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".happy-plugin-sdk-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "api.sock");
        const server = createServer((_request, response) => {
            response.end(JSON.stringify({ projects: [{ name: "Missing fields" }] }));
        });
        servers.push(server);
        await listen(server, socketPath);

        const client = createHappyPluginClient({ socketPath, token: "extension-token" });
        await expect(client.projects.list()).rejects.toThrow();
    });

    it("surfaces daemon errors and missing injected settings in human language", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".happy-plugin-sdk-"));
        temporaryDirectories.push(directory);
        const socketPath = join(directory, "api.sock");
        const server = createServer((_request, response) => {
            response.writeHead(409);
            response.end(JSON.stringify({ error: "The workspace already exists." }));
        });
        servers.push(server);
        await listen(server, socketPath);

        const client = createHappyPluginClient({ socketPath, token: "extension-token" });
        await expect(client.projects.list()).rejects.toEqual(
            new HappyPluginApiError(409, "The workspace already exists."),
        );
        await expect(
            createHappyPluginClient({ socketPath: "", token: "" }).projects.list(),
        ).rejects.toThrow("HAPPY_PLUGIN_SOCKET_PATH");
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
