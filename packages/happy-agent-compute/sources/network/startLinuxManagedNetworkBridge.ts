import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";

import type { ManagedNetworkProxyHandle } from "./ManagedNetworkPolicy.js";
import { runCleanupSteps } from "../sandbox/impl/runCleanupSteps.js";

export interface LinuxManagedNetworkBridge {
    authenticationToken: string;
    close(): Promise<void>;
    httpSocketPath: string;
    loopbackSockets: readonly { path: string; port: number }[];
    socksSocketPath: string;
}

export async function startLinuxManagedNetworkBridge(
    proxy: ManagedNetworkProxyHandle,
    options: { directory?: string; loopbackPorts?: readonly number[] } = {},
): Promise<LinuxManagedNetworkBridge> {
    const directory = options.directory ?? (await mkdtemp("/tmp/agent-compute-network-"));
    const removeDirectory = options.directory === undefined;
    const authenticationToken = randomBytes(32).toString("hex");
    const httpSocketPath = join(directory, "http.sock");
    const socksSocketPath = join(directory, "socks.sock");
    const loopbackSockets = (options.loopbackPorts ?? []).map((port) => ({
        path: join(directory, `loopback-${String(port)}.sock`),
        port,
    }));
    const bridges: AuthenticatedUnixBridge[] = [];
    try {
        bridges.push(
            await startAuthenticatedUnixBridge(httpSocketPath, proxy.port, authenticationToken),
        );
        bridges.push(
            await startAuthenticatedUnixBridge(
                socksSocketPath,
                proxy.socksPort,
                authenticationToken,
            ),
        );
        for (const { path, port } of loopbackSockets) {
            bridges.push(await startAuthenticatedUnixBridge(path, port, authenticationToken));
        }
    } catch (error) {
        await runCleanupSteps("Linux network bridge startup", [
            ...bridges.map((bridge) => () => bridge.close()),
            ...(removeDirectory ? [() => rm(directory, { force: true, recursive: true })] : []),
        ]);
        throw error;
    }
    let closed = false;
    return {
        authenticationToken,
        httpSocketPath,
        loopbackSockets,
        socksSocketPath,
        async close() {
            if (closed) return;
            await runCleanupSteps("Linux network bridge", [
                ...bridges.map((bridge) => () => bridge.close()),
                ...(removeDirectory ? [() => rm(directory, { force: true, recursive: true })] : []),
            ]);
            closed = true;
        },
    };
}

interface AuthenticatedUnixBridge {
    close(): Promise<void>;
}

async function startAuthenticatedUnixBridge(
    socketPath: string,
    targetPort: number,
    authenticationToken: string,
): Promise<AuthenticatedUnixBridge> {
    const sockets = new Set<Socket>();
    const server = createServer((client) => {
        sockets.add(client);
        client.once("close", () => sockets.delete(client));
        authenticateAndRelay(client, targetPort, authenticationToken, sockets);
    });
    try {
        await listen(server, socketPath);
        await makeSocketConnectableAcrossUserNamespaces(socketPath);
    } catch (error) {
        await closeServer(server);
        throw error;
    }
    let closed = false;
    return {
        async close() {
            if (closed) return;
            closed = true;
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            await closeServer(server);
        },
    };
}

function authenticateAndRelay(
    client: Socket,
    targetPort: number,
    authenticationToken: string,
    sockets: Set<Socket>,
): void {
    const expectedFrame = Buffer.from(authenticationToken);
    let received = Buffer.alloc(0);
    const authenticationTimeout = setTimeout(() => client.destroy(), 1_000);
    authenticationTimeout.unref();
    client.on("error", () => {});
    client.once("close", () => clearTimeout(authenticationTimeout));
    const onData = (chunk: Buffer) => {
        client.pause();
        const needed = expectedFrame.length - received.length;
        received = Buffer.concat([received, chunk.subarray(0, needed)]);
        if (received.length < expectedFrame.length) {
            client.resume();
            return;
        }
        clearTimeout(authenticationTimeout);
        client.off("data", onData);
        if (!received.equals(expectedFrame)) {
            client.destroy();
            return;
        }
        const initialPayload = chunk.subarray(needed);
        const upstream = connect(targetPort, "127.0.0.1");
        sockets.add(upstream);
        upstream.on("error", () => client.destroy());
        upstream.once("close", () => sockets.delete(upstream));
        client.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
            if (initialPayload.length > 0) upstream.write(initialPayload);
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
        });
    };
    client.on("data", onData);
}

async function listen(server: Server, socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

async function makeSocketConnectableAcrossUserNamespaces(socketPath: string): Promise<void> {
    try {
        await chmod(socketPath, 0o666);
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "EINVAL" || error.code === "ENOTSUP")
        ) {
            // Docker Desktop's shared filesystem rejects chmod on Unix sockets but already
            // permits the cross-container connection. Native Linux filesystems accept chmod.
            return;
        }
        throw error;
    }
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
