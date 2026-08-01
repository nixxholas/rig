import { request as requestHttp } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

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
                list: async () => ({
                    failures: [],
                    plugins: [
                        {
                            dataDirectory: "/data/clock",
                            description: "A clock.",
                            directory: "/plugins/clock",
                            folder: "clock",
                            logAvailable: true,
                            name: "Clock",
                            status: "stopped",
                        },
                    ],
                }),
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
});

function requestJson(port: number, path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const request = requestHttp(
            {
                headers: { authorization: "Bearer secret" },
                host: "127.0.0.1",
                path,
                port,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        request.once("error", reject);
        request.end();
    });
}
