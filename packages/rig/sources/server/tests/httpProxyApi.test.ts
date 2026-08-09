import { rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("daemon HTTP proxy", () => {
    it("forwards arbitrary HTTP methods and preserves upstream authorization", async () => {
        const upstream = createHttpServer();
        const received = new Promise<Record<string, unknown>>((resolve) => {
            upstream.on("request", async (request, response) => {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                resolve({
                    authorization: request.headers.authorization,
                    body: Buffer.concat(chunks).toString("utf8"),
                    method: request.method,
                    proxyAuthorization: request.headers["proxy-authorization"],
                    removed: request.headers["x-remove"],
                    rigSessionId: request.headers["x-rig-session-id"],
                });
                response.writeHead(201, { "x-upstream": "yes" });
                response.end("proxied");
            });
        });
        await listenTcp(upstream);
        const rig = await startRigProxy();
        try {
            const session = await rig.client.createSession({ cwd: "/tmp/rig-http-proxy" });
            const scope = { projectId: session.session.projectId! };
            const port = (upstream.address() as AddressInfo).port;
            const response = await rig.client.proxyHttpRequest(scope, {
                body: Buffer.from("request body"),
                headers: {
                    authorization: "Bearer upstream-secret",
                    connection: "x-remove",
                    "x-remove": "not-forwarded",
                },
                method: "POST",
                url: `http://127.0.0.1:${String(port)}/anything?value=1`,
            });
            expect(response.statusCode).toBe(201);
            expect(await readText(response.body)).toBe("proxied");
            expect(response.headers["x-upstream"]).toBe("yes");
            await expect(received).resolves.toEqual({
                authorization: "Bearer upstream-secret",
                body: "request body",
                method: "POST",
                proxyAuthorization: undefined,
                removed: undefined,
                rigSessionId: undefined,
            });
        } finally {
            await rig.close();
            await close(upstream);
        }
    });

    it("carries a bidirectional CONNECT tunnel and rejects missing API credentials", async () => {
        const upstream = createTcpServer((socket) => {
            socket.on("data", (chunk) =>
                socket.write(Buffer.concat([Buffer.from("echo:"), chunk])),
            );
        });
        await listenTcp(upstream);
        const rig = await startRigProxy();
        try {
            const session = await rig.client.createSession({ cwd: "/tmp/rig-connect-proxy" });
            const scope = { projectId: session.session.projectId! };
            const port = (upstream.address() as AddressInfo).port;
            const tunnel = await rig.client.connectHttpProxy(scope, `127.0.0.1:${String(port)}`);
            const echoed = new Promise<string>((resolve) => {
                tunnel.once("data", (chunk) => resolve(Buffer.from(chunk).toString("utf8")));
            });
            tunnel.write("hello");
            await expect(echoed).resolves.toBe("echo:hello");
            tunnel.destroy();

            const unauthorized = await rawTunnelRequest(
                rig.socketPath,
                `/projects/${encodeURIComponent(session.session.projectId!)}/proxy`,
            );
            expect(unauthorized).toBe(401);
            const oldSessionRoute = await rawTunnelRequest(
                rig.socketPath,
                `/sessions/${encodeURIComponent(session.session.id)}/proxy`,
                { authorization: "Bearer secret" },
            );
            expect(oldSessionRoute).toBe(404);
        } finally {
            await rig.close();
            await close(upstream);
        }
    });

    it("closes active CONNECT tunnels when the daemon server closes", async () => {
        const upstream = createTcpServer();
        await listenTcp(upstream);
        const rig = await startRigProxy();
        try {
            const session = await rig.client.createSession({ cwd: "/tmp/rig-close-proxy" });
            const port = (upstream.address() as AddressInfo).port;
            const tunnel = await rig.client.connectHttpProxy(
                { projectId: session.session.projectId! },
                `127.0.0.1:${String(port)}`,
            );
            const closed = new Promise<void>((resolve) => tunnel.once("close", () => resolve()));
            await rig.close();
            await expect(closed).resolves.toBeUndefined();
        } finally {
            await close(upstream);
        }
    });

    it("requires an existing project scope without consulting session runtime state", async () => {
        const upstream = createHttpServer((_request, response) => response.end("unexpected"));
        await listenTcp(upstream);
        const rig = await startRigProxy();
        try {
            const port = (upstream.address() as AddressInfo).port;
            const target = `http://127.0.0.1:${String(port)}/`;
            const missing = await rawTunnelRequest(rig.socketPath, "/proxy", {
                authorization: "Bearer secret",
            });
            expect(missing).toBe(404);

            await expect(
                rig.client.proxyHttpRequest({ projectId: "missing-project" }, { url: target }),
            ).rejects.toMatchObject({ statusCode: 404 });

            const session = await rig.client.createSession({
                cwd: "/tmp/rig-docker-proxy",
                docker: { container: "not-started", workingDirectory: "/workspace" },
            });
            const scope = { projectId: session.session.projectId! };
            const response = await rig.client.proxyHttpRequest(scope, { url: target });
            expect(response.statusCode).toBe(200);
            expect(await readText(response.body)).toBe("unexpected");
        } finally {
            await rig.close();
            await close(upstream);
        }
    });
});

async function startRigProxy(): Promise<{
    client: ProtocolHttpClient;
    close(): Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    directories.push(directory);
    const socketPath = join(directory, "server.sock");
    const server = await createProtocolHttpServer({ token: "secret" });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    return {
        client: new ProtocolHttpClient({ socketPath, token: "secret" }),
        socketPath,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

function listenTcp(
    server: ReturnType<typeof createHttpServer> | ReturnType<typeof createTcpServer>,
) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}

function close(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createTcpServer>) {
    return new Promise<void>((resolve) => server.close(() => resolve()));
}

function rawTunnelRequest(
    socketPath: string,
    path: string,
    headers?: Record<string, string>,
): Promise<number> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            { headers, method: "CONNECT", path, socketPath },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 500));
            },
        );
        request.once("connect", (response, socket) => {
            socket.destroy();
            resolve(response.statusCode ?? 500);
        });
        request.once("error", reject);
        request.end();
    });
}

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
