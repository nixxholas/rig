import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rm } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { P2pHttpRequest, P2pNetwork } from "../../p2p/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("P2P-prefixed daemon HTTP", () => {
    it("forwards a request and streams the peer response", async () => {
        const fetch = vi.fn(
            async (_peerId: string, _request: P2pHttpRequest, _signal: AbortSignal) => ({
                response: {
                    body: (async function* () {
                        yield Buffer.from("first");
                        yield Buffer.from("second");
                    })(),
                    headers: { "content-type": "text/plain" },
                    status: 202,
                },
                transport: "iroh" as const,
            }),
        );
        const started = await startServer({ fetch } as unknown as P2pNetwork);
        try {
            const result = await sendRequest(
                started.socketPath,
                "/p2p/peers/remote-endpoint/api/messages?scope=all",
                {
                    authorization: "Bearer test-token",
                    "content-type": "text/plain",
                    cookie: "must-not-cross",
                    "x-rig-mutation-id": "mutation-one",
                },
                "request body",
            );

            expect(result).toEqual({
                body: "firstsecond",
                headers: expect.objectContaining({
                    "content-type": "text/plain",
                    "x-rig-p2p-peer": "remote-endpoint",
                    "x-rig-p2p-transport": "iroh",
                }),
                status: 202,
            });
            expect(fetch).toHaveBeenCalledOnce();
            const [peerId, forwarded, signal] = fetch.mock.calls[0]!;
            expect(peerId).toBe("remote-endpoint");
            expect(forwarded).toMatchObject({
                headers: {
                    "content-type": "text/plain",
                    "x-rig-mutation-id": "mutation-one",
                },
                method: "POST",
                path: "/messages?scope=all",
            });
            expect(Buffer.from(forwarded.body).toString("utf8")).toBe("request body");
            expect(signal).toBeInstanceOf(AbortSignal);
        } finally {
            await started.close();
        }
    });

    it("keeps the prefix authenticated and refuses recursive P2P forwarding", async () => {
        const fetch = vi.fn();
        const started = await startServer({ fetch } as unknown as P2pNetwork);
        try {
            await expect(
                sendRequest(started.socketPath, "/p2p/peers/remote-endpoint/api/health", {}),
            ).resolves.toMatchObject({ status: 401 });
            await expect(
                sendRequest(started.socketPath, "/p2p/peers/remote-endpoint/api/p2p/status", {
                    authorization: "Bearer test-token",
                }),
            ).resolves.toMatchObject({ status: 403 });
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            await started.close();
        }
    });
});

async function startServer(p2pNetwork: P2pNetwork): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const server = createProtocolHttpServer({ p2pNetwork, token: "test-token" });
    await listen(server, socketPath);
    return {
        close: async () => {
            await close(server);
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}

function sendRequest(
    socketPath: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    body = "",
): Promise<{
    body: string;
    headers: IncomingHttpHeaders;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers, method: body.length === 0 ? "GET" : "POST", path, socketPath },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}
