import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open } from "node:fs/promises";

import {
    HappyAgentClient,
    HAPPY_AGENT_PROTOCOL_VERSION,
    type HealthResponse,
} from "@slopus/happy-agent-client";

import {
    getDaemonIdentity,
    getHappyDaemonPaths,
    runHappyAgentServer,
    type HappyDaemonPaths,
} from "../daemon/index.js";
import {
    readDaemonToken,
    readDaemonTokenIfPresent,
    readOrCreateDaemonToken,
} from "../daemon/daemonToken.js";
import { rotateDaemonLog } from "../daemon/rotateDaemonLog.js";
import { RigUserError } from "../RigUserError.js";
import type { DaemonIdentity } from "../protocol/index.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { stopLocalProtocolServer } from "./stopLocalProtocolServer.js";

const DAEMON_CHILD_STARTUP_TIMEOUT_MS = 60_000;
const DAEMON_CHILD_TERMINATION_TIMEOUT_MS = 2_000;
const DAEMON_RESTART_ATTEMPTS = 20;

export interface LocalProtocolServerConnection {
    client: HappyAgentClient;
    paths: HappyDaemonPaths;
    token: string;
}

export interface EnsureLocalProtocolServerOptions {
    confirmRestart?: (request: DaemonRestartRequest) => Promise<boolean>;
    onStatus?: (message: string) => void;
}

export interface DaemonRestartRequest {
    currentIdentity: DaemonIdentity;
    runningIdentity: DaemonIdentity;
}

/**
 * Connects to the local Happy agent daemon, starting one when none is running.
 *
 * The daemon is the complete Happy agent (`rig --server` runs `startHappyAgentDaemon`); Rig only
 * observes its health, matches its identity, and spawns or restarts the process.
 */
export async function ensureLocalProtocolServer(
    options: EnsureLocalProtocolServerOptions = {},
): Promise<LocalProtocolServerConnection> {
    const paths = getHappyDaemonPaths();
    const currentIdentity = getDaemonIdentity();
    await mkdir(paths.directory, { mode: 0o700, recursive: true });

    for (let attempt = 0; attempt < DAEMON_RESTART_ATTEMPTS; attempt += 1) {
        const observed = await observeLocalProtocolServer(paths);
        if (observed !== undefined && daemonVersionsMatch(currentIdentity, observed.health)) {
            return await connectToObservedServer(observed, paths);
        }

        if (observed !== undefined) {
            const request: DaemonRestartRequest = {
                currentIdentity,
                runningIdentity: { version: observed.health.version.daemon },
            };
            const shouldRestart = (await options.confirmRestart?.(request)) ?? false;
            if (!shouldRestart) {
                throw new RigUserError("The running daemon does not match this Rig CLI.", {
                    hint: "Run rig daemon stop, then try again.",
                });
            }
            options.onStatus?.("Restarting local daemon.");
            await stopLocalProtocolServer(observed.client, paths.socketPath);
        }

        options.onStatus?.("Starting local daemon.");
        const connection = await startLocalProtocolServer(paths, options);
        const health = await readHealth(connection.client);
        // Another Rig may have won the race to start a daemon with a different identity; observe
        // again instead of handing back a connection to the wrong daemon.
        if (health === undefined || !daemonVersionsMatch(currentIdentity, health)) {
            await delay(250);
            continue;
        }
        return connection;
    }
    throw new RigUserError("Rig could not start the local daemon.", {
        hint: "Another Rig process keeps replacing it. Run rig daemon stop, then try again.",
    });
}

export async function readTokenIfPresent(tokenPath: string): Promise<string | undefined> {
    return readDaemonTokenIfPresent(tokenPath);
}

interface ObservedLocalProtocolServer {
    client: HappyAgentClient;
    health: HealthResponse;
    token: string;
}

async function observeLocalProtocolServer(
    paths: HappyDaemonPaths,
): Promise<ObservedLocalProtocolServer | undefined> {
    const token = await readDaemonTokenIfPresent(paths.tokenPath);
    if (token === undefined) return undefined;
    const client = createDaemonClient(paths, token);
    const health = await readHealth(client);
    return health === undefined ? undefined : { client, health, token };
}

async function connectToObservedServer(
    observed: ObservedLocalProtocolServer,
    paths: HappyDaemonPaths,
): Promise<LocalProtocolServerConnection> {
    await resolveReadyHealth(observed.client, observed.health);
    return { client: observed.client, paths, token: observed.token };
}

async function startLocalProtocolServer(
    paths: HappyDaemonPaths,
    options: EnsureLocalProtocolServerOptions,
): Promise<LocalProtocolServerConnection> {
    const token = await readOrCreateDaemonToken(paths.tokenPath);
    let child: ChildProcess | undefined;
    if (process.env.RIG_GYM_IN_PROCESS_DAEMON === "1") {
        void runHappyAgentServer().catch((error: unknown) => {
            options.onStatus?.(
                `Local daemon stopped: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    } else {
        child = await spawnLocalServer(paths);
    }
    const client = createDaemonClient(paths, token);
    const readiness = waitForReady(client);
    if (child === undefined) {
        await readiness;
    } else {
        await superviseSpawnedLocalServer(child, readiness, DAEMON_CHILD_STARTUP_TIMEOUT_MS);
    }
    // The daemon may have created its own token when none existed; reread so the connection uses
    // whatever the daemon actually serves.
    const servedToken = await readDaemonToken(paths.tokenPath);
    return {
        client: servedToken === token ? client : createDaemonClient(paths, servedToken),
        paths,
        token: servedToken,
    };
}

function createDaemonClient(paths: HappyDaemonPaths, token: string): HappyAgentClient {
    return new HappyAgentClient({
        endpoint: "http://happy",
        fetch: createUnixSocketFetch(paths.socketPath),
        token,
    });
}

async function readHealth(client: HappyAgentClient): Promise<HealthResponse | undefined> {
    try {
        return await client.getHealth();
    } catch {
        return undefined;
    }
}

async function spawnLocalServer(paths: HappyDaemonPaths): Promise<ChildProcess> {
    const entrypoint = process.argv[1];
    if (entrypoint === undefined) {
        throw new Error("Cannot locate the current CLI entrypoint.");
    }

    await rotateDaemonLog(paths.logPath).catch(() => undefined);
    const log = await open(paths.logPath, "a", 0o600);
    try {
        await log.chmod(0o600);
        const child = spawn(process.execPath, [...process.execArgv, entrypoint, "--server"], {
            detached: true,
            env: process.env,
            stdio: ["ignore", log.fd, log.fd],
        });
        return child;
    } finally {
        await log.close();
    }
}

export interface SpawnedLocalServerProcess {
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): boolean;
    once(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
    removeListener(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
    unref(): void;
}

/**
 * Keeps a replacement child owned until it proves that it can serve the socket. A child that
 * stalls during startup is terminated and reaped instead of becoming an invisible detached daemon
 * that can survive for days.
 */
export async function superviseSpawnedLocalServer<Result>(
    child: SpawnedLocalServerProcess,
    readiness: Promise<Result>,
    timeoutMs: number,
): Promise<Result> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error("Timed out while starting the local Rig daemon.")),
                timeoutMs,
            );
            timer.unref();
        });
        const result = await Promise.race([readiness, timeout]);
        child.unref();
        return result;
    } catch (error) {
        await terminateSpawnedLocalServer(child);
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function terminateSpawnedLocalServer(child: SpawnedLocalServerProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
        let forceTimer: NodeJS.Timeout | undefined;
        let reapTimer: NodeJS.Timeout | undefined;
        const finish = () => {
            if (forceTimer !== undefined) clearTimeout(forceTimer);
            if (reapTimer !== undefined) clearTimeout(reapTimer);
            child.removeListener("exit", onExit);
            resolve();
        };
        const onExit = () => finish();
        child.once("exit", onExit);
        forceTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, DAEMON_CHILD_TERMINATION_TIMEOUT_MS / 2);
        reapTimer = setTimeout(finish, DAEMON_CHILD_TERMINATION_TIMEOUT_MS);
        forceTimer.unref();
        reapTimer.unref();
        child.kill("SIGTERM");
    });
}

export async function waitForReady(client: HappyAgentClient): Promise<HealthResponse> {
    let deadline = Date.now() + 5_000;
    let observedStarting = false;
    let recoveredAfterStartingFailure = false;
    while (Date.now() < deadline) {
        let health: HealthResponse;
        try {
            health = await client.getHealth();
        } catch {
            // The socket may not be accepting connections yet.
            if (observedStarting && !recoveredAfterStartingFailure) {
                recoveredAfterStartingFailure = true;
                deadline = Date.now() + 5_000;
            }
            await delay(50);
            continue;
        }
        assertCompatibleProtocol(health);
        if (health.ready) return health;
        observedStarting = true;
        deadline = Date.now() + 5_000;
        await delay(50);
    }

    if (observedStarting) {
        throw new Error("The local daemon stopped responding while it was starting.");
    }
    throw new Error("Timed out while waiting for the local Rig server.");
}

async function resolveReadyHealth(
    client: HappyAgentClient,
    health: HealthResponse,
): Promise<HealthResponse> {
    assertCompatibleProtocol(health);
    if (health.ready) return health;
    return waitForReady(client);
}

function assertCompatibleProtocol(health: HealthResponse): void {
    if (health.version.protocol === HAPPY_AGENT_PROTOCOL_VERSION) return;
    throw new RigUserError(
        `The running daemon uses protocol ${String(health.version.protocol)}, but this Rig expects protocol ${String(HAPPY_AGENT_PROTOCOL_VERSION)}.`,
        { hint: "Restart the daemon with this Rig version." },
    );
}

function daemonVersionsMatch(identity: DaemonIdentity, health: HealthResponse): boolean {
    return (
        health.version.protocol === HAPPY_AGENT_PROTOCOL_VERSION &&
        health.version.daemon === identity.version
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
