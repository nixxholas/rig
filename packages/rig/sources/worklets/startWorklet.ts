import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { createSandboxedCommand } from "../agent/context/createSandboxedCommand.js";
import { getRigHome } from "../config/getRigHome.js";
import { createToolEnvironment } from "../agent/context/createToolEnvironment.js";
import { startSandboxedProcessNetwork } from "../agent/context/startSandboxedProcessNetwork.js";
import { killProcessTree } from "../processes/killProcessTree.js";
import type { WorkletPermissions } from "../protocol/WorkletProtocol.js";
import { BoundedProcessLog } from "../utils/BoundedProcessLog.js";
import { getWorkletsDirectory } from "./getWorkletsDirectory.js";
import { resolveWorkletPermissions } from "./resolveWorkletPermissions.js";
import { createWorkletApiServer } from "./createWorkletApiServer.js";
import { createWorkletNodeRuntime } from "./createWorkletNodeRuntime.js";
import { WorkletInvalidError } from "./WorkletInvalidError.js";
import { WorkletStartupState } from "./WorkletStartupState.js";
import type { WorkletToolConnection, WorkletToolRegistry } from "./WorkletToolRegistry.js";
import { builtWorkletEntry } from "./buildWorkletSource.js";

const STOP_GRACE_MS = 2_000;
const SOCKET_FILE_NAME = "worklet.sock";
const TEMPORARY_DIRECTORY_NAME = "tmp";
/** `sockaddr_un` holds 104 bytes on macOS and 108 on Linux, so the smaller bound is the safe one. */
const MAXIMUM_SOCKET_PATH_BYTES = 103;

export interface RunningWorklet {
    readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly dataDirectory: string;
    readonly logPath: string;
    readonly name: string;
    readonly pid: number | undefined;
    readonly startup: WorkletStartupState;
    readonly statusMessage: string | undefined;
    readonly tools: WorkletToolConnection;
    close(options?: { force?: boolean }): Promise<void>;
}

export interface StartWorkletOptions {
    dataDirectory: string;
    environment?: NodeJS.ProcessEnv;
    logPath: string;
    name: string;
    onStatus?: (status: string) => void;
    /** What the current version's manifest declared, and what this launch enforces. */
    permissions: WorkletPermissions;
    registry: WorkletToolRegistry;
    /** Rig's private folder for this worklet's socket and disposable per-run temporary files. */
    runtimeDirectory: string;
    /** Retires the worklet when the tools it declared at startup go away underneath it. */
    onToolsRetired?: (reason: string) => void;
    versionDirectory: string;
}

/**
 * Starts one worklet process.
 *
 * The worklet's code is read-only to it: the process is sandboxed with its `Data` folder as the
 * only writable place by default, which is also its working directory. The socket it reaches Rig
 * on is not the worklet's own file, so it lives in Rig's private per-worklet runtime folder and is
 * granted to the sandbox by name. The worklet's data folder therefore holds only what it wrote.
 *
 * Anything beyond that — other writable paths, or any network at all — comes from the permissions
 * its own manifest declared, so what a worklet can reach is what a person approved at install.
 */
export async function startWorklet(options: StartWorkletOptions): Promise<RunningWorklet> {
    const environment = options.environment ?? process.env;
    const permissions = resolveWorkletPermissions(options.permissions, { environment });
    const entryPath = builtWorkletEntry(options.versionDirectory);
    const socketPath = resolveSocketPath(options.runtimeDirectory, options.name);
    const temporaryDirectory = join(options.runtimeDirectory, TEMPORARY_DIRECTORY_NAME);
    await mkdir(options.dataDirectory, { mode: 0o755, recursive: true });
    await mkdir(options.runtimeDirectory, { mode: 0o700, recursive: true });
    await chmod(options.runtimeDirectory, 0o700);
    await Promise.all([
        rm(options.logPath, { force: true }),
        rm(`${options.logPath}.next`, { force: true }),
        rm(socketPath, { force: true }),
        rm(temporaryDirectory, { force: true, recursive: true }),
    ]);
    await mkdir(temporaryDirectory, { mode: 0o700 });

    const token = randomBytes(32).toString("base64url");
    const startup = new WorkletStartupState();
    let processState: "starting" | "running" | "closing" | "exited" = "starting";
    let statusMessage: string | undefined;
    const tools = options.registry.createConnection(
        { name: options.name, permissions: options.permissions },
        {
            onActiveRegistrationRetired: (retirement) => {
                if (startup.fail(retirement.reason)) return;
                if (processState === "closing" || processState === "exited") return;
                options.onToolsRetired?.(retirement.reason);
            },
        },
    );
    const server = createWorkletApiServer({
        onStatus: (status) => {
            statusMessage = status;
            options.onStatus?.(status);
        },
        startup,
        token,
        tools,
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });
        await secureSocket(socketPath, options.runtimeDirectory);
    } catch (error) {
        tools.close();
        await closeServer(server);
        await Promise.all([
            rm(socketPath, { force: true }),
            rm(temporaryDirectory, { force: true, recursive: true }),
        ]);
        throw error;
    }

    const log = new BoundedProcessLog({ path: options.logPath });
    let child;
    // A worklet that named specific hosts reaches them through Rig's managed proxy, which lives
    // for exactly as long as the worklet process does.
    let network;
    try {
        network = await startSandboxedProcessNetwork(permissions.networkPolicy);
        const node = await createWorkletNodeRuntime({ entryPath });
        const command = await createSandboxedCommand({
            additionalWritablePaths: permissions.writablePaths,
            // Linux tears down the worklet's private PID namespace and Windows uses taskkill /T.
            // macOS has no equivalent containment primitive, so its Seatbelt profile refuses
            // subprocess creation and prevents a detached generation from escaping teardown.
            allowSubprocesses: process.platform !== "darwin",
            // These sit inside the roots withheld below, so only the durable data folder and one
            // disposable private temp folder are restored. The containing runtime folder remains
            // read-only to the worklet; its pre-bound socket is granted separately by exact path.
            alwaysWritablePaths: [options.dataDirectory, temporaryDirectory],
            argv: [...node.argv],
            command: node.executable,
            commandCwd: options.dataDirectory,
            cwd: options.dataDirectory,
            filesystemFullAccess: permissions.fullDiskAccess,
            mode: "workspace_write",
            networkFullAccess: permissions.fullNetworkAccess,
            // Withheld from every worklet whatever it declared, because these hold the other
            // worklets' code and Rig's own state. A worklet able to write here would be rewriting
            // what another worklet runs, and so running under that worklet's granted permissions
            // instead of the ones its own install was reviewed against.
            protectedPaths: [getWorkletsDirectory(environment), getRigHome(environment)],
            protectProjectMetadata: false,
            shell: environment.SHELL?.trim() || "/bin/sh",
            temporaryDirectory,
            unixSocketPaths: [socketPath],
            ...network?.sandboxOptions,
        });
        const workletEnvironment = {
            ...(await createToolEnvironment("workspace_write", environment, {
                cwd: options.dataDirectory,
                temporaryDirectory,
            })),
            HAPPY_WORKLET_DATA_DIRECTORY: options.dataDirectory,
            HAPPY_WORKLET_NAME: options.name,
            HAPPY_WORKLET_SOCKET_PATH: socketPath,
            HAPPY_WORKLET_TOKEN: token,
            TEMP: temporaryDirectory,
            TMP: temporaryDirectory,
            TMPDIR: temporaryDirectory,
        };
        child = spawn(command.command, command.args ?? [], {
            cwd: options.dataDirectory,
            detached: process.platform !== "win32",
            env: network?.withProxyEnvironment(workletEnvironment) ?? workletEnvironment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        processState = "running";
    } catch (error) {
        tools.close();
        await Promise.allSettled([
            closeServer(server),
            log.close(),
            network?.close(),
            rm(socketPath, { force: true }),
            rm(temporaryDirectory, { force: true, recursive: true }),
        ]);
        throw error;
    }

    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
        },
    );
    child.stdout?.on("data", (chunk: Buffer) => log.append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => log.append("stderr", chunk));

    let finalized: Promise<void> | undefined;
    const finalize = () =>
        (finalized ??= Promise.allSettled([
            closeChild(child, completion, true),
            closeServer(server),
            log.close(),
            network?.close(),
            rm(socketPath, { force: true }),
            rm(temporaryDirectory, { force: true, recursive: true }),
        ]).then(() => {
            tools.close();
        }));
    const settled = completion.then(
        (result) => {
            processState = "exited";
            void finalize();
            return result;
        },
        (error: unknown) => {
            processState = "exited";
            void finalize();
            throw error;
        },
    );

    return {
        completion: settled,
        dataDirectory: options.dataDirectory,
        logPath: options.logPath,
        name: options.name,
        pid: child.pid,
        startup,
        get statusMessage() {
            return statusMessage;
        },
        tools,
        async close(closeOptions = {}) {
            if (processState !== "exited") processState = "closing";
            try {
                await closeChild(child, completion, closeOptions.force === true);
            } finally {
                await finalize();
            }
        },
    };
}

/**
 * Names the socket inside Rig's private runtime folder for this worklet.
 *
 * A Unix socket address is a fixed-size field in the kernel, so an over-long path fails with an
 * opaque `EINVAL` at bind time. Saying so plainly beats letting that surface as the worklet's
 * failure reason.
 */
function resolveSocketPath(runtimeDirectory: string, name: string): string {
    const socketPath = join(runtimeDirectory, SOCKET_FILE_NAME);
    if (Buffer.byteLength(socketPath) > MAXIMUM_SOCKET_PATH_BYTES) {
        throw new WorkletInvalidError(
            `Rig's runtime folder for the worklet ${JSON.stringify(name)} is too deeply nested for it to be given a socket. Its path must be under ${String(MAXIMUM_SOCKET_PATH_BYTES - SOCKET_FILE_NAME.length - 1)} characters.`,
        );
    }
    return socketPath;
}

async function secureSocket(socketPath: string, runtimeDirectory: string): Promise<void> {
    try {
        await chmod(socketPath, 0o600);
    } catch (error) {
        // Docker Desktop bind mounts reject chmod on Unix socket nodes with EINVAL. The socket is
        // still private when its containing directory is 0700, because another user cannot search
        // that directory to reach the socket. Never accept the fallback for any other error or a
        // directory whose mode does not preserve that boundary.
        if (
            !isNodeError(error) ||
            error.code !== "EINVAL" ||
            ((await stat(runtimeDirectory)).mode & 0o777) !== 0o700
        ) {
            throw error;
        }
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

async function closeChild(
    child: ReturnType<typeof spawn>,
    completion: Promise<unknown>,
    force: boolean,
): Promise<void> {
    const running = child.exitCode === null && child.signalCode === null;
    if (!running) {
        signalChildTree(child, "SIGKILL");
        return;
    }
    signalChildTree(child, force ? "SIGKILL" : "SIGTERM");
    if (force) {
        await completion.catch(() => undefined);
        return;
    }
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
    // The process group can still contain descendants after its leader exits. A final group-only
    // kill is safe even then and ensures an old worklet generation cannot survive replacement.
    if (stopped) {
        signalChildTree(child, "SIGKILL");
        return;
    }
    signalChildTree(child, "SIGKILL");
    await completion.catch(() => undefined);
}

function signalChildTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
        killProcessTree(pid, signal);
        return;
    }
    try {
        // The child was spawned detached, so this negative id names only its process group.
        process.kill(-pid, signal);
    } catch {
        // Fall back to the leader only while it is known to be ours. Once it exits, the bare id
        // may be recycled and must never be signalled.
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
}

function closeServer(server: ReturnType<typeof createWorkletApiServer>): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}
