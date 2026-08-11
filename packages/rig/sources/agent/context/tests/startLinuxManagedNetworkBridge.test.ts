import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ManagedNetworkProxyHandle } from "../ManagedNetworkPolicy.js";
import { startLinuxManagedNetworkBridge } from "../startLinuxManagedNetworkBridge.js";

const closeables: { close(): Promise<void> }[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
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
        const bridge = await startLinuxManagedNetworkBridge({
            blockedRequest: () => undefined,
            close: async () => {},
            onBlockedRequest: () => () => {},
            port: address.port,
            socksPort: address.port,
        } satisfies ManagedNetworkProxyHandle);
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

    it("closes the HTTP bridge when the SOCKS bridge cannot start", async () => {
        const moduleUrl = new URL("../startLinuxManagedNetworkBridge.ts", import.meta.url).href;
        const script = `
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startLinuxManagedNetworkBridge } = await import(${JSON.stringify(moduleUrl)});
const directory = await mkdtemp(join(tmpdir(), "rig-bridge-partial-start-"));
const socksPath = join(directory, "socks.sock");
const occupied = createServer();
await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(socksPath, resolve);
});
try {
    await startLinuxManagedNetworkBridge(
        {
            blockedRequest: () => undefined,
            close: async () => {},
            onBlockedRequest: () => () => {},
            port: 1,
            socksPort: 1,
        },
        { directory },
    );
} catch {}
await new Promise((resolve) => occupied.close(resolve));
const probe = createServer();
const leaked = await new Promise((resolve) => {
    probe.once("error", () => resolve(true));
    probe.listen(join(directory, "http.sock"), () => resolve(false));
});
if (!leaked) await new Promise((resolve) => probe.close(resolve));
await rm(directory, { force: true, recursive: true });
process.stdout.write(leaked ? "leaked" : "closed");
process.exit(leaked ? 1 : 0);
`;

        await expect(
            execFileAsync(process.execPath, [
                "--import",
                "tsx",
                "--input-type=module",
                "--eval",
                script,
            ]),
        ).resolves.toMatchObject({ stdout: "closed" });
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
