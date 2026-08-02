import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const PLUGIN_CONTAINER_TOKEN_PATH = "/happy-plugin-runtime/plugin-token";
const MAXIMUM_BRIDGE_CONNECTIONS = 64;
const BRIDGE_HANDSHAKE_TIMEOUT_MS = 30_000;

const bootstrapInputSchema = Type.Object(
    {
        pluginArguments: Type.Array(Type.String(), { minItems: 1 }),
        port: Type.Integer({ maximum: 65_535, minimum: 0 }),
        socketPath: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
type BootstrapInput = Static<typeof bootstrapInputSchema>;

const input: unknown = {
    pluginArguments: process.argv.slice(3),
    port: Number(process.argv[2]),
    socketPath: process.env.HAPPY_PLUGIN_SOCKET_PATH,
};
if (!Value.Check(bootstrapInputSchema, input)) {
    throw new Error("Rig did not provide valid Docker plugin bootstrap arguments.");
}
const { pluginArguments, port, socketPath }: BootstrapInput = input;
const token = (await readFile(PLUGIN_CONTAINER_TOKEN_PATH, "utf8")).trim();
if (token.length === 0) throw new Error("Rig did not provide a Docker plugin token.");

const bridge = port === 0 ? undefined : await startBridge(socketPath, port, token);
const child = spawn("node", pluginArguments, {
    env: {
        ...process.env,
        HAPPY_PLUGIN_TOKEN: token,
    },
    stdio: "inherit",
});
const signalHandlers = new Map<NodeJS.Signals, () => void>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => child.kill(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
}
const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    },
);
await bridge?.close();
if (result.signal !== null) {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    process.kill(process.pid, result.signal);
} else {
    process.exitCode = result.code ?? 1;
}

async function startBridge(
    socketPath: string,
    port: number,
    token: string,
): Promise<{ close(): Promise<void> }> {
    await rm(socketPath, { force: true });
    const sockets = new Set<Socket>();
    let activeConnections = 0;
    const server = createServer((client) => {
        if (activeConnections >= MAXIMUM_BRIDGE_CONNECTIONS) {
            client.destroy();
            return;
        }
        activeConnections += 1;
        trackSocket(client, sockets);
        const markClientEstablished = armPluginDockerBridgeHandshakeTimeout(client);
        client.once("close", () => {
            activeConnections -= 1;
        });
        const upstream = connect({
            host: "host.docker.internal",
            port,
        });
        trackSocket(upstream, sockets);
        const markUpstreamEstablished = armPluginDockerBridgeHandshakeTimeout(upstream);
        upstream.on("error", () => client.destroy());
        client.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
            markClientEstablished();
            markUpstreamEstablished();
            upstream.write(token);
            client.pipe(upstream);
            upstream.pipe(client);
        });
    });
    await listen(server, socketPath);
    let closed = false;
    return {
        async close() {
            if (closed) return;
            closed = true;
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            await closeServer(server);
            await rm(socketPath, { force: true });
        },
    };
}

function trackSocket(socket: Socket, sockets: Set<Socket>): void {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
}

function armPluginDockerBridgeHandshakeTimeout(socket: Socket): () => void {
    let established = false;
    socket.setTimeout(BRIDGE_HANDSHAKE_TIMEOUT_MS, () => {
        if (!established) socket.destroy();
    });
    return () => {
        established = true;
        socket.setTimeout(0);
    };
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
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => server.close(() => resolve()));
}
