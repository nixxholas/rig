import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { createSandboxedCommand } from "../agent/context/createSandboxedCommand.js";
import { createToolEnvironment } from "../agent/context/createToolEnvironment.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import { buildExtension, type BuildExtensionOptions } from "./buildExtension.js";
import { createExtensionApiServer } from "./createExtensionApiServer.js";
import { ExtensionLog } from "./ExtensionLog.js";
import { fileSystemErrorSchema, type RegisteredExtension } from "./types.js";

const STOP_GRACE_MS = 2_000;

export interface RunningExtension {
    readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly logPath: string;
    readonly name: string;
    readonly pid: number | undefined;
    close(): Promise<void>;
}

export interface StartExtensionOptions extends BuildExtensionOptions {
    defaultDocker?: DockerExecutionConfig;
    environment?: NodeJS.ProcessEnv;
    store: SessionStore;
}

export async function startExtension(
    extension: RegisteredExtension,
    options: StartExtensionOptions,
): Promise<RunningExtension> {
    const built = await buildExtension(extension, options);
    const environment = options.environment ?? process.env;
    const runtimeSocketDirectory = join(built.runtimeDirectory, "runtime");
    const socketPath = join(runtimeSocketDirectory, "plugin.sock");
    const logPath = join(built.runtimeDirectory, "extension.log");
    await mkdir(runtimeSocketDirectory, { mode: 0o700, recursive: true });
    await chmod(runtimeSocketDirectory, 0o700);
    await Promise.all([rm(logPath, { force: true }), rm(socketPath, { force: true })]);

    const token = randomBytes(32).toString("base64url");
    const server = createExtensionApiServer({
        ...(options.defaultDocker === undefined ? {} : { defaultDocker: options.defaultDocker }),
        extensionName: extension.manifest.name,
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
        await closeServer(server);
        await rm(socketPath, { force: true });
        throw error;
    }

    let child: ChildProcess;
    const log = new ExtensionLog({ path: logPath });
    try {
        const command = await createSandboxedCommand({
            argv: [process.execPath, built.builtEntryPath],
            command: process.execPath,
            commandCwd: extension.directory,
            cwd: extension.directory,
            mode: "workspace_write",
            shell: environment.SHELL?.trim() || "/bin/sh",
        });
        child = spawn(command.command, command.args ?? [], {
            cwd: extension.directory,
            env: {
                ...(await createToolEnvironment("workspace_write", environment, {
                    cwd: extension.directory,
                })),
                HAPPY_PLUGIN_DIRECTORY: extension.directory,
                HAPPY_PLUGIN_SOCKET_PATH: socketPath,
                HAPPY_PLUGIN_TOKEN: token,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
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
        ]).then(() => undefined));
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
        logPath,
        name: extension.manifest.name,
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

function closeServer(server: ReturnType<typeof createExtensionApiServer>): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}
