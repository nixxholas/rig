import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { createSandboxedCommand } from "../agent/context/createSandboxedCommand.js";
import { createToolEnvironment } from "../agent/context/createToolEnvironment.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { GeneratedMediaStore } from "../generated-media/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import { createPluginNodeRuntime } from "./createPluginNodeRuntime.js";
import {
    createPluginApiServer,
    type CreatePluginApiServerOptions,
} from "./createPluginApiServer.js";
import { getPluginDataDirectory } from "./getPluginDataDirectory.js";
import { PluginLog } from "./PluginLog.js";
import type { PluginMcpRegistry } from "./PluginMcpRegistry.js";
import type { PluginAppRegistry } from "./PluginAppRegistry.js";
import { fileSystemErrorSchema, type RegisteredPlugin } from "./types.js";
import { snapshotPluginApps } from "./snapshotPluginApps.js";

const STOP_GRACE_MS = 2_000;

export interface RunningPlugin {
    readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly dataDirectory: string;
    readonly logPath: string;
    readonly name: string;
    readonly pid: number | undefined;
    close(): Promise<void>;
}

export interface StartPluginOptions {
    appRegistry?: PluginAppRegistry;
    dataDirectory?: string;
    defaultDocker?: DockerExecutionConfig;
    environment?: NodeJS.ProcessEnv;
    generatedMedia?: GeneratedMediaStore;
    listPlugins: CreatePluginApiServerOptions["listPlugins"];
    listProviderUsage?: CreatePluginApiServerOptions["listProviderUsage"];
    mcpRegistry?: PluginMcpRegistry;
    store: SessionStore;
}

export async function startPlugin(
    plugin: RegisteredPlugin,
    options: StartPluginOptions,
): Promise<RunningPlugin> {
    if (plugin.entryPath === undefined) {
        throw new Error("A plugin without a main entry point has no process to start.");
    }
    const runtime = {
        ...plugin,
        apps: await snapshotPluginApps(plugin),
    };
    const environment = options.environment ?? process.env;
    // The plugin's code lives in Rig's managed folder, so everything it writes at runtime — its own
    // state and the socket it connects back through — belongs in the folder a person can open.
    const dataDirectory =
        options.dataDirectory ?? getPluginDataDirectory(plugin.folderName, environment);
    const runtimeSocketDirectory = join(dataDirectory, ".runtime");
    const socketPath = join(runtimeSocketDirectory, "plugin.sock");
    const logPath = join(plugin.directory, "plugin.log");
    await mkdir(dataDirectory, { mode: 0o755, recursive: true });
    await mkdir(runtimeSocketDirectory, { mode: 0o700, recursive: true });
    await chmod(runtimeSocketDirectory, 0o700);
    await Promise.all([
        rm(logPath, { force: true }),
        rm(`${logPath}.next`, { force: true }),
        rm(socketPath, { force: true }),
    ]);

    const token = randomBytes(32).toString("base64url");
    const mcp = options.mcpRegistry?.createConnection({
        folder: plugin.folderName,
        name: plugin.manifest.name,
    });
    let unregisterApps: (() => void) | undefined;
    try {
        unregisterApps =
            mcp === undefined
                ? undefined
                : options.appRegistry?.register(runtime, mcp.generation, dataDirectory);
    } catch (error) {
        mcp?.close();
        throw error;
    }
    const server = createPluginApiServer({
        ...(options.defaultDocker === undefined ? {} : { defaultDocker: options.defaultDocker }),
        ...(options.listProviderUsage === undefined
            ? {}
            : { listProviderUsage: options.listProviderUsage }),
        listPlugins: options.listPlugins,
        ...(options.generatedMedia === undefined ? {} : { generatedMedia: options.generatedMedia }),
        ...(mcp === undefined ? {} : { mcp }),
        pluginFolder: plugin.folderName,
        pluginDataDirectory: dataDirectory,
        pluginName: plugin.manifest.name,
        store: options.store,
        token,
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });
        await restrictSocketAccess(socketPath);
    } catch (error) {
        unregisterApps?.();
        mcp?.close();
        await closeServer(server);
        await rm(socketPath, { force: true });
        throw error;
    }

    let child: ChildProcess;
    const log = new PluginLog({ path: logPath });
    try {
        const node = await createPluginNodeRuntime({ entryPath: plugin.entryPath });
        const command = await createSandboxedCommand({
            argv: [...node.argv],
            command: node.executable,
            commandCwd: dataDirectory,
            cwd: dataDirectory,
            mode: "workspace_write",
            shell: environment.SHELL?.trim() || "/bin/sh",
        });
        child = spawn(command.command, command.args ?? [], {
            cwd: dataDirectory,
            env: {
                ...(await createToolEnvironment("workspace_write", environment, {
                    cwd: dataDirectory,
                })),
                HAPPY_PLUGIN_DIRECTORY: dataDirectory,
                HAPPY_PLUGIN_SOCKET_PATH: socketPath,
                HAPPY_PLUGIN_TOKEN: token,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        unregisterApps?.();
        mcp?.close();
        await Promise.allSettled([closeServer(server), log.close()]);
        await rm(socketPath, { force: true });
        throw error;
    }

    child.stdout?.on("data", (chunk: Buffer) => log.append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => log.append("stderr", chunk));
    let finalized: Promise<void> | undefined;
    const finalize = () =>
        (finalized ??= Promise.allSettled([
            closeServer(server),
            log.close(),
            rm(socketPath, { force: true }),
        ]).then(() => {
            unregisterApps?.();
            mcp?.close();
        }));
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
            child.once("error", (error) => {
                void finalize();
                reject(error);
            });
            child.once("exit", (code, signal) => {
                void finalize();
                resolve({ code, signal });
            });
        },
    );

    return {
        completion,
        dataDirectory,
        logPath,
        name: plugin.manifest.name,
        pid: child.pid,
        async close() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
                const stopped = await Promise.race([
                    completion.then(
                        () => true,
                        () => true,
                    ),
                    new Promise<false>((resolve) => {
                        const timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
                        timer.unref();
                    }),
                ]);
                if (!stopped) {
                    child.kill("SIGKILL");
                    await completion.catch(() => undefined);
                }
            }
            await finalize();
        },
    };
}

async function restrictSocketAccess(socketPath: string): Promise<void> {
    try {
        await chmod(socketPath, 0o600);
    } catch (error) {
        // Docker Desktop bind mounts reject chmod on Unix sockets even though the
        // containing runtime directory is private and every request requires a token.
        if (!Value.Check(fileSystemErrorSchema, error) || error.code !== "EINVAL") throw error;
    }
}

function closeServer(server: ReturnType<typeof createPluginApiServer>): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}
