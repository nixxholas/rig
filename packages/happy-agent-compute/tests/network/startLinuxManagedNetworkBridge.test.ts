import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ManagedNetworkProxyHandle } from "../../sources/network/ManagedNetworkPolicy.js";
import { startLinuxManagedNetworkBridge } from "../../sources/network/startLinuxManagedNetworkBridge.js";

const closeables: { close(): Promise<void> }[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("startLinuxManagedNetworkBridge", () => {
    it("requires the command-scoped token before relaying a shared Unix socket", async () => {
        let upstreamConnections = 0;
        const upstream = createServer((socket) => {
            upstreamConnections += 1;
            socket.pipe(socket);
        });
        await listen(upstream);
        closeables.push({ close: () => closeServer(upstream) });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port.");
        // Keep the shared bridge sockets inside the workspace so the socket bind is permitted when
        // this runs under a restricted host sandbox. The directory name stays short because a Unix
        // socket path has a small fixed maximum length.
        const directory = await mkdtemp(join(process.cwd(), "b"));
        temporaryDirectories.push(directory);
        const bridge = await startLinuxManagedNetworkBridge(
            {
                blockedRequest: () => undefined,
                close: async () => {},
                onBlockedRequest: () => () => {},
                port: address.port,
                socksPort: address.port,
            } satisfies ManagedNetworkProxyHandle,
            { directory },
        );
        closeables.push(bridge);

        if (process.platform === "linux") {
            expect((await stat(bridge.httpSocketPath)).mode & 0o222).toBe(0o222);
        }

        const unauthenticated = connect(bridge.httpSocketPath);
        unauthenticated.on("error", () => {});
        unauthenticated.end("GET / HTTP/1.0\r\n\r\n");
        await closed(unauthenticated);
        expect(upstreamConnections).toBe(0);

        const authenticated = connect(bridge.httpSocketPath);
        authenticated.write(`${bridge.authenticationToken}hello`);
        expect(await read(authenticated, 5)).toBe("hello");
        expect(upstreamConnections).toBe(1);
        authenticated.destroy();
    });
});

async function listen(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closed(socket: Socket): Promise<void> {
    if (socket.closed) return;
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

async function read(socket: Socket, bytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("data", (chunk: Buffer) => resolve(chunk.subarray(0, bytes).toString("utf8")));
    });
}
