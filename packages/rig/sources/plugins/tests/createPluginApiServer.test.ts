import { request as requestHttp } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { createHappyPluginClient } from "happy-plugins";
import { afterEach, describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createPluginApiServer } from "../createPluginApiServer.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("plugin API server", () => {
    it("requires its plugin token and serves SDK requests over its Unix socket", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-plugin-api-"));
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const server = createPluginApiServer({
            pluginName: "Test Plugin",
            store,
            token: "private-plugin-token",
        });
        cleanup.push(
            () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeAllConnections();
                }),
        );
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });

        await expect(
            createHappyPluginClient({
                socketPath,
                token: "private-plugin-token",
            }).projects.list(),
        ).resolves.toEqual([]);
        await expect(unauthorizedStatus(socketPath)).resolves.toBe(401);
    });
});

function unauthorizedStatus(socketPath: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const request = requestHttp(
            { method: "GET", path: "/projects", socketPath },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 500));
            },
        );
        request.once("error", reject);
        request.end();
    });
}
