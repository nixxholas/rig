import { isAbsolute, resolve } from "node:path";

import type { Context } from "@steve.kite/stdlib";

import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import { assertComputePermissions, type ComputePermissions } from "../ComputePermissions.js";
import type {
    ComputeRunResult,
    ComputeSessionExit,
    ComputeSessionSnapshot,
    ComputeShell,
} from "../ComputeShell.js";
import {
    NativeProcessManager,
    resolveSystemShell,
    type ManagedProcess,
    type ProcessRunOptions,
    type ProcessRunResult,
    type ProcessStartOptions,
} from "../processes/index.js";
import { createSandboxedCommand } from "../sandbox/createSandboxedCommand.js";
import { createToolEnvironment } from "../sandbox/impl/createToolEnvironment.js";
import type { ProjectConfigPlaceholder } from "../sandbox/prepareProjectConfigPlaceholder.js";
import { formatManagedNetworkDenial } from "../network/impl/formatManagedNetworkDenial.js";
import {
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkInterceptor,
    type ManagedNetworkPolicy,
    type ManagedNetworkProxyHandle,
} from "../network/ManagedNetworkPolicy.js";
import {
    type SandboxedProcessNetwork,
    startSandboxedProcessNetwork,
} from "../network/startSandboxedProcessNetwork.js";
import {
    createProtectedPathMonitor,
    type ProtectedPathMonitor,
} from "./impl/createProtectedPathMonitor.js";
import {
    DEFAULT_HOST_COMMAND_TIMEOUT_MS,
    DEFAULT_HOST_MAX_OUTPUT_BYTES,
    HOST_SESSION_STOP_GRACE_MS,
    MAX_ACTIVE_HOST_SESSIONS,
    MAX_RETAINED_HOST_SESSIONS,
} from "./impl/hostSessionLimits.js";
import { waitForHostSessionCompletion } from "./impl/waitForHostSessionCompletion.js";
import {
    assertCanUseCustomShell,
    assertSecretsUnsupported,
} from "./impl/assertHostCommandOptions.js";

/** How a compute-owned managed network is started, so tests can inject a stub. */
export type StartManagedNetwork = (
    policy: ManagedNetworkPolicy | undefined,
) => Promise<
    | (Pick<SandboxedProcessNetwork, "close" | "proxy"> &
          Partial<Pick<SandboxedProcessNetwork, "sandboxOptions" | "withProxyEnvironment">>)
    | undefined
>;

/**
 * A managed network normalized to a concrete shape.
 *
 * An injected {@link StartManagedNetwork} may omit `sandboxOptions` or `withProxyEnvironment`; the
 * shell fills those in once so the rest of the code never has to re-check them.
 */
interface HostManagedNetwork {
    sandboxOptions: SandboxedProcessNetwork["sandboxOptions"];
    proxy?: ManagedNetworkProxyHandle;
    close(): Promise<void>;
    withProxyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

export interface HostShellOptions {
    /** The context that owns the compute's process lifetime; sessions never retain a tool call. */
    ctx: Context;
    /** The directory commands run in by default. */
    cwd: string;
    processManager: NativeProcessManager;
    environment?: NodeJS.ProcessEnv;
    hostPolicy?: ComputeHostPolicy;
    /** The home directory used to identify universal private credential paths. */
    homeDirectory?: string;
    networkInterceptor?: ManagedNetworkInterceptor;
    /** Overrides how the managed network is started, for tests. */
    startManagedNetwork?: StartManagedNetwork;
    /** How many commands may run at once before the oldest is evicted. Defaults to the host cap. */
    maxActiveSessions?: number;
    /** How many finished commands stay readable before the oldest is forgotten. */
    maxRetainedSessions?: number;
}

interface HostSession {
    command: string;
    completionStderrDelta?: string;
    completionWaiters: Set<() => void>;
    /**
     * Readers waiting for the end who will also report it.
     *
     * An observer that only peeks waits the same way but consumes nothing, so it must not be
     * mistaken for someone about to tell the model the news.
     */
    consumingWaiters: number;
    cwd: string;
    /** Stopped to make room for a newer command, but still readable. */
    evicted?: true;
    /** A read has already returned this session's final status. */
    exitObserved: boolean;
    managedNetwork?: HostManagedNetwork;
    process: ManagedProcess;
    result?: ProcessRunResult;
    sessionId: number;
    stderrOffset: number;
    stdoutOffset: number;
    timedOut: boolean;
    timeout?: NodeJS.Timeout;
}

/**
 * The session manager around the native process manager, in the shape of the {@link ComputeShell}
 * contract.
 *
 * A command either runs to completion within its timeout or becomes a session the agent comes back
 * to: reaching the timeout backgrounds a session, it never stops the command. A session outlives
 * the tool call and the turn, and belongs to the compute that started it, so it is captured with
 * the compute's owning context rather than any per-call one.
 */
export function createHostShell(options: HostShellOptions): ComputeShell {
    const sessions = new Map<number, HostSession>();
    let nextSessionId = 1;
    let pendingSessionStarts = 0;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;

    const maxActiveSessions = options.maxActiveSessions ?? MAX_ACTIVE_HOST_SESSIONS;
    const maxRetainedSessions = options.maxRetainedSessions ?? MAX_RETAINED_HOST_SESSIONS;
    const runCwd = (cwd: string | undefined) =>
        cwd === undefined ? options.cwd : isAbsolute(cwd) ? cwd : resolve(options.cwd, cwd);
    const permissionPaths = (paths: readonly string[]) =>
        paths.map((path) => (isAbsolute(path) ? path : resolve(options.cwd, path)));
    const activeSessionCount = () =>
        [...sessions.values()].filter((session) => session.result === undefined && !session.evicted)
            .length;
    const activeSessions = () =>
        [...sessions.values()]
            .filter((session) => session.result === undefined && !session.evicted)
            .map((session) => ({
                command: session.command,
                cwd: session.cwd,
                sessionId: session.sessionId,
                status: "running" as const,
            }));

    const startManagedNetwork = async (
        policy: ManagedNetworkPolicy | undefined,
    ): Promise<HostManagedNetwork | undefined> => {
        const managedNetwork =
            options.startManagedNetwork === undefined
                ? await startSandboxedProcessNetwork(
                      policy,
                      options.networkInterceptor === undefined
                          ? {}
                          : { networkInterceptor: options.networkInterceptor },
                  )
                : await options.startManagedNetwork(policy);
        if (managedNetwork === undefined) return undefined;
        return {
            sandboxOptions: managedNetwork.sandboxOptions ?? {},
            ...(managedNetwork.proxy === undefined ? {} : { proxy: managedNetwork.proxy }),
            close: () => managedNetwork.close(),
            withProxyEnvironment(environment) {
                return managedNetwork.withProxyEnvironment?.(environment) ?? environment;
            },
        };
    };

    /**
     * Makes room for one more command. Running out of slots is our problem, not the model's, so the
     * oldest command is evicted to free one.
     *
     * The evicted session stays readable: it is stopped, not forgotten, so a model still holding its
     * task ID learns what became of it. Only its slot is released, and immediately, so a command
     * that ignores the signal cannot keep the next one from starting.
     */
    const reserveSessionStart = () => {
        while (activeSessionCount() + pendingSessionStarts >= maxActiveSessions) {
            const oldest = [...sessions.values()]
                .filter((session) => session.result === undefined && !session.evicted)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) {
                throw new Error(
                    `No more than ${String(maxActiveSessions)} background commands can run at once.`,
                );
            }
            oldest.evicted = true;
            void oldest.process.kill(options.ctx, "SIGTERM", {
                forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
            });
        }
        pendingSessionStarts += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            pendingSessionStarts -= 1;
        };
    };

    /**
     * Forgets the oldest finished commands once too many have piled up.
     *
     * Runs whenever a command starts or ends, so a session that only ever finishes work still lets
     * go of what it is holding.
     */
    const trimFinishedSessions = () => {
        while (sessions.size > maxRetainedSessions) {
            const finished = [...sessions.values()]
                .filter((candidate) => candidate.result !== undefined)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            sessions.delete(finished.sessionId);
        }
    };

    const readSession = async (
        sessionId: number,
        readOptions: Parameters<ComputeShell["readSession"]>[1] = {},
    ): Promise<ComputeSessionSnapshot | undefined> => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        const waitMs = Math.max(0, readOptions.waitMs ?? 0);
        const peeking = readOptions.peek === true;
        if (session.result === undefined && waitMs > 0 && !readOptions.signal?.aborted) {
            if (!peeking) session.consumingWaiters += 1;
            try {
                await waitForHostSessionCompletion(
                    session.completionWaiters,
                    waitMs,
                    readOptions.signal,
                );
            } finally {
                if (!peeking) session.consumingWaiters -= 1;
            }
        }

        const processSnapshot = session.process.readOutput(
            session.stdoutOffset,
            session.stderrOffset,
            !peeking,
        );
        const completionStderrDelta = session.completionStderrDelta ?? "";
        if (!peeking) {
            delete session.completionStderrDelta;
            session.stdoutOffset = processSnapshot.stdoutOffset;
            session.stderrOffset = processSnapshot.stderrOffset;
            if (session.result !== undefined) session.exitObserved = true;
        }
        const stderrDelta = `${processSnapshot.stderrDelta}${completionStderrDelta}`;
        const stderrDeltaBytes =
            (processSnapshot.stderrDeltaBytes ??
                Buffer.byteLength(processSnapshot.stderrDelta, "utf8")) +
            Buffer.byteLength(completionStderrDelta, "utf8");
        const stdoutDeltaBytes =
            processSnapshot.stdoutDeltaBytes ??
            Buffer.byteLength(processSnapshot.stdoutDelta, "utf8");
        return {
            command: session.command,
            cwd: session.cwd,
            exitCode: session.result?.exitCode ?? null,
            sessionId,
            status:
                session.result === undefined
                    ? "running"
                    : session.result.killed
                      ? "killed"
                      : "completed",
            stderr: session.result?.stderr ?? processSnapshot.stderr,
            stderrDelta,
            ...(processSnapshot.stderrBytes === undefined
                ? {}
                : { stderrBytes: processSnapshot.stderrBytes }),
            ...(processSnapshot.stderrOmittedBytes === undefined
                ? {}
                : { stderrOmittedBytes: processSnapshot.stderrOmittedBytes }),
            stderrDeltaBytes,
            stderrDeltaOmittedBytes: processSnapshot.stderrDeltaOmittedBytes,
            stdout: session.result?.stdout ?? processSnapshot.stdout,
            stdoutDelta: processSnapshot.stdoutDelta,
            ...(processSnapshot.stdoutBytes === undefined
                ? {}
                : { stdoutBytes: processSnapshot.stdoutBytes }),
            ...(processSnapshot.stdoutOmittedBytes === undefined
                ? {}
                : { stdoutOmittedBytes: processSnapshot.stdoutOmittedBytes }),
            stdoutDeltaBytes,
            stdoutDeltaOmittedBytes: processSnapshot.stdoutDeltaOmittedBytes,
            timedOut: session.timedOut,
        };
    };

    return {
        activeSessionCount,
        activeSessions,
        cwd: options.cwd,
        detachSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session !== undefined) session.process.detached = true;
        },
        async interruptSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            return session.process.interrupt(options.ctx);
        },
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => session.result === undefined);
            // Everything is being taken down at once, by us. Telling the model about each casualty
            // afterwards would say nothing it does not know.
            for (const session of active) session.exitObserved = true;
            await Promise.all(
                active.map((session) =>
                    session.process.kill(options.ctx, "SIGTERM", {
                        forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
                    }),
                ),
            );
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            // Whoever stopped the command is told how it ended by this very call, so claim the
            // outcome before the exit continuation can run and announce it a second time.
            session.exitObserved = true;
            await session.process.kill(options.ctx, "SIGTERM", {
                forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
            });
            // The process is gone, but this session records the outcome from a separate
            // continuation. Wait for that before reporting status, otherwise a just-killed command
            // still reads as running.
            if (session.result === undefined) {
                await waitForHostSessionCompletion(session.completionWaiters, 5_000);
            }
            // Stopping a command reports its status; it must not swallow output the model has not
            // read yet.
            return readSession(sessionId, { peek: true });
        },
        readSession,
        async run(runOptions) {
            const permissions = runOptions.permissions;
            assertComputePermissions(permissions);
            const mode = permissions.mode;
            assertCanUseCustomShell(mode, runOptions.shell);
            assertSecretsUnsupported(runOptions.secrets);
            const cwd = runCwd(runOptions.cwd);
            const shell = runOptions.shell ?? resolveSystemShell(options.environment);
            const toolEnvironment = await createToolEnvironment(mode, options.environment, {
                cwd: options.cwd,
                ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
                ...(options.homeDirectory === undefined
                    ? {}
                    : { homeDirectory: options.homeDirectory }),
            });
            const networkPolicy = toManagedNetworkPolicy(permissions);
            const managedNetwork = await startManagedNetwork(networkPolicy);
            let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
            try {
                sandboxedCommand = await createSandboxedCommand({
                    command: runOptions.command,
                    commandCwd: cwd,
                    cwd: options.cwd,
                    ...(options.environment === undefined
                        ? {}
                        : { environment: options.environment }),
                    ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
                    ...(options.homeDirectory === undefined
                        ? {}
                        : { homeDirectory: options.homeDirectory }),
                    ...(permissions.allowedReadPaths === undefined
                        ? {}
                        : {
                              additionalReadablePaths: permissionPaths(
                                  permissions.allowedReadPaths,
                              ),
                          }),
                    ...(permissions.allowedWritePaths === undefined
                        ? {}
                        : {
                              additionalWritablePaths: permissionPaths(
                                  permissions.allowedWritePaths,
                              ),
                          }),
                    ...(permissions.deniedReadPaths === undefined
                        ? {}
                        : { deniedReadPaths: permissionPaths(permissions.deniedReadPaths) }),
                    ...(permissions.deniedWritePaths === undefined
                        ? {}
                        : { deniedWritePaths: permissionPaths(permissions.deniedWritePaths) }),
                    filesystemFullAccess: mode === "full_access",
                    mode,
                    networkAllowLocalBinding: permissions.network.localBinding,
                    networkFullAccess: usesDirectEgress(permissions),
                    ...managedNetwork?.sandboxOptions,
                    ...(toolEnvironment.PATH === undefined ? {} : { path: toolEnvironment.PATH }),
                    shell,
                });
            } catch (error) {
                await managedNetwork?.close();
                throw error;
            }
            const commandEnvironment = toolEnvironment;
            const processRunOptions: ProcessRunOptions = {
                command: sandboxedCommand.command,
                cwd,
                env: managedNetwork?.withProxyEnvironment(commandEnvironment) ?? commandEnvironment,
                timeoutMs: runOptions.timeoutMs ?? DEFAULT_HOST_COMMAND_TIMEOUT_MS,
                maxOutputBytes: runOptions.maxOutputBytes ?? DEFAULT_HOST_MAX_OUTPUT_BYTES,
                ...(runOptions.tty === undefined ? {} : { tty: runOptions.tty }),
            };
            if (sandboxedCommand.args !== undefined) {
                processRunOptions.args = sandboxedCommand.args;
            } else {
                processRunOptions.shell = shell;
            }
            let networkDenial: ManagedNetworkBlockedRequest | undefined;
            const commandAbort = new AbortController();
            const abortFromCaller = () => commandAbort.abort();
            runOptions.signal?.addEventListener("abort", abortFromCaller, { once: true });
            if (runOptions.signal?.aborted) commandAbort.abort();
            const stopObservingNetworkDenials = managedNetwork?.proxy?.onBlockedRequest(
                (request) => {
                    networkDenial ??= request;
                    commandAbort.abort();
                },
            );
            if (runOptions.signal !== undefined || managedNetwork?.proxy !== undefined) {
                processRunOptions.signal = commandAbort.signal;
            }

            let protectedPathMonitor: ProtectedPathMonitor;
            try {
                protectedPathMonitor = await createProtectedPathMonitor(
                    sandboxedCommand.protectedCreatePaths ?? [],
                );
            } catch (error) {
                await cleanUpCommandResources(
                    { stop: async () => false },
                    managedNetwork,
                    sandboxedCommand.projectConfigPlaceholders,
                );
                throw error;
            }
            let result: ProcessRunResult;
            let cleanup: CommandCleanupResult = { protectedPathViolation: false };
            try {
                result = await options.processManager.run(options.ctx, processRunOptions);
            } finally {
                stopObservingNetworkDenials?.();
                runOptions.signal?.removeEventListener("abort", abortFromCaller);
                cleanup = await cleanUpCommandResources(
                    protectedPathMonitor,
                    managedNetwork,
                    sandboxedCommand.projectConfigPlaceholders,
                );
            }
            const protectedPathMessage =
                cleanup.protectedPathViolation && result.exitCode === 0
                    ? "Sandbox blocked creation of a protected project path.\n"
                    : "";
            const networkDenialMessage =
                networkDenial === undefined
                    ? ""
                    : formatManagedNetworkDenial(networkDenial, options.hostPolicy);
            return {
                stdout: result.stdout,
                stderr: `${result.stderr}${networkDenialMessage}${protectedPathMessage}${cleanup.errorMessage ?? ""}`,
                ...(result.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
                ...(result.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
                ...(result.stdoutOmittedBytes === undefined
                    ? {}
                    : { stdoutOmittedBytes: result.stdoutOmittedBytes }),
                ...(result.stderrOmittedBytes === undefined
                    ? {}
                    : { stderrOmittedBytes: result.stderrOmittedBytes }),
                exitCode:
                    networkDenial !== undefined ||
                    cleanup.errorMessage !== undefined ||
                    (cleanup.protectedPathViolation && result.exitCode === 0)
                        ? 1
                        : result.exitCode,
                timedOut: result.timedOut,
            } satisfies ComputeRunResult;
        },
        async startSession(runOptions) {
            // Validate before making room: a command that is never going to start must not cost the
            // user a running one.
            const permissions = runOptions.permissions;
            assertComputePermissions(permissions);
            const mode = permissions.mode;
            assertCanUseCustomShell(mode, runOptions.shell);
            assertSecretsUnsupported(runOptions.secrets);
            const releaseSessionStart = reserveSessionStart();
            try {
                const cwd = runCwd(runOptions.cwd);
                const shell = runOptions.shell ?? resolveSystemShell(options.environment);
                const toolEnvironment = await createToolEnvironment(mode, options.environment, {
                    cwd: options.cwd,
                    ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
                    ...(options.homeDirectory === undefined
                        ? {}
                        : { homeDirectory: options.homeDirectory }),
                });
                const networkPolicy = toManagedNetworkPolicy(permissions);
                const managedNetwork = await startManagedNetwork(networkPolicy);
                let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
                try {
                    sandboxedCommand = await createSandboxedCommand({
                        command: runOptions.command,
                        commandCwd: cwd,
                        cwd: options.cwd,
                        ...(options.environment === undefined
                            ? {}
                            : { environment: options.environment }),
                        ...(options.hostPolicy === undefined
                            ? {}
                            : { hostPolicy: options.hostPolicy }),
                        ...(options.homeDirectory === undefined
                            ? {}
                            : { homeDirectory: options.homeDirectory }),
                        ...(permissions.allowedReadPaths === undefined
                            ? {}
                            : {
                                  additionalReadablePaths: permissionPaths(
                                      permissions.allowedReadPaths,
                                  ),
                              }),
                        ...(permissions.allowedWritePaths === undefined
                            ? {}
                            : {
                                  additionalWritablePaths: permissionPaths(
                                      permissions.allowedWritePaths,
                                  ),
                              }),
                        ...(permissions.deniedReadPaths === undefined
                            ? {}
                            : { deniedReadPaths: permissionPaths(permissions.deniedReadPaths) }),
                        ...(permissions.deniedWritePaths === undefined
                            ? {}
                            : { deniedWritePaths: permissionPaths(permissions.deniedWritePaths) }),
                        filesystemFullAccess: mode === "full_access",
                        mode,
                        networkAllowLocalBinding: permissions.network.localBinding,
                        networkFullAccess: usesDirectEgress(permissions),
                        ...managedNetwork?.sandboxOptions,
                        ...(toolEnvironment.PATH === undefined
                            ? {}
                            : { path: toolEnvironment.PATH }),
                        shell,
                    });
                } catch (error) {
                    await managedNetwork?.close();
                    throw error;
                }
                const commandEnvironment = toolEnvironment;
                const processStartOptions: ProcessStartOptions = {
                    command: sandboxedCommand.command,
                    cwd,
                    env:
                        managedNetwork?.withProxyEnvironment(commandEnvironment) ??
                        commandEnvironment,
                    maxOutputBytes: runOptions.maxOutputBytes ?? DEFAULT_HOST_MAX_OUTPUT_BYTES,
                    ...(runOptions.tty === undefined ? {} : { tty: runOptions.tty }),
                };
                if (sandboxedCommand.args !== undefined) {
                    processStartOptions.args = sandboxedCommand.args;
                } else {
                    processStartOptions.shell = shell;
                }
                let protectedPathMonitor: ProtectedPathMonitor;
                try {
                    protectedPathMonitor = await createProtectedPathMonitor(
                        sandboxedCommand.protectedCreatePaths ?? [],
                    );
                } catch (error) {
                    await cleanUpCommandResources(
                        { stop: async () => false },
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholders,
                    );
                    throw error;
                }
                let process: ManagedProcess;
                try {
                    process = await options.processManager.start(options.ctx, processStartOptions);
                } catch (error) {
                    await cleanUpCommandResources(
                        protectedPathMonitor,
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholders,
                    );
                    throw error;
                }
                const completion = process.wait(options.ctx);
                const sessionId = nextSessionId;
                nextSessionId += 1;
                const session: HostSession = {
                    command: runOptions.command,
                    completionWaiters: new Set(),
                    consumingWaiters: 0,
                    cwd,
                    exitObserved: false,
                    process,
                    ...(managedNetwork === undefined ? {} : { managedNetwork }),
                    sessionId,
                    stderrOffset: 0,
                    stdoutOffset: 0,
                    timedOut: false,
                };
                // Reaching the timeout backgrounds the session; it marks it timed out and never
                // stops the command, which keeps running for the agent to come back to.
                if (runOptions.timeoutMs !== undefined) {
                    session.timeout = setTimeout(
                        () => {
                            session.timedOut = true;
                        },
                        Math.max(0, runOptions.timeoutMs),
                    );
                    session.timeout.unref();
                }
                let networkDenial: ManagedNetworkBlockedRequest | undefined;
                const stopObservingNetworkDenials = managedNetwork?.proxy?.onBlockedRequest(
                    (request) => {
                        networkDenial ??= request;
                        void process.kill(options.ctx, "SIGTERM", {
                            forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
                        });
                    },
                );
                sessions.set(sessionId, session);
                onActiveSessionCountChange?.(activeSessionCount());
                void completion.then(async (result) => {
                    if (session.timeout !== undefined) clearTimeout(session.timeout);
                    stopObservingNetworkDenials?.();
                    const cleanup = await cleanUpCommandResources(
                        protectedPathMonitor,
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholders,
                    );
                    const protectedPathMessage =
                        cleanup.protectedPathViolation && result.exitCode === 0
                            ? "Sandbox blocked creation of a protected project path.\n"
                            : "";
                    const networkDenialMessage =
                        networkDenial === undefined
                            ? ""
                            : formatManagedNetworkDenial(networkDenial, options.hostPolicy);
                    const completionStderrDelta = `${networkDenialMessage}${protectedPathMessage}${cleanup.errorMessage ?? ""}`;
                    if (completionStderrDelta !== "") {
                        session.completionStderrDelta = completionStderrDelta;
                    }
                    session.result = {
                        ...result,
                        exitCode:
                            networkDenial !== undefined ||
                            cleanup.errorMessage !== undefined ||
                            (cleanup.protectedPathViolation && result.exitCode === 0)
                                ? 1
                                : result.exitCode,
                        killed: networkDenial === undefined ? result.killed : false,
                        stderr: `${result.stderr}${completionStderrDelta}`,
                    };
                    const awaited = session.consumingWaiters > 0;
                    for (const finish of session.completionWaiters) finish();
                    onActiveSessionCountChange?.(activeSessionCount());
                    trimFinishedSessions();
                    // Nobody was waiting on this command, so nobody is about to learn that it
                    // ended. Say so, without the output.
                    if (!awaited && !session.exitObserved) {
                        await onSessionExit?.({
                            command: session.command,
                            exitCode: session.result.exitCode,
                            sessionId,
                            status: session.result.killed ? "killed" : "completed",
                        });
                    }
                });
                trimFinishedSessions();
                return sessionId;
            } finally {
                releaseSessionStart();
            }
        },
        setActiveSessionCountListener(listener) {
            onActiveSessionCountChange = listener;
            listener?.(activeSessionCount());
        },
        setSessionExitListener(listener) {
            onSessionExit = listener;
        },
        sessionUsesSecrets() {
            // The host compute never injects secrets, so no session is ever secret-bearing.
            return false;
        },
        supportsSessionInput: true,
        async writeSession(_permissions, sessionId, data) {
            const session = sessions.get(sessionId);
            return session?.process.writeStdin(options.ctx, data) ?? false;
        },
    };
}

/**
 * Uses the managed proxy only when an allow-list must be enforced, or when Linux needs isolated
 * networking to keep unrestricted egress separate from accepting incoming connections.
 */
function toManagedNetworkPolicy(permissions: ComputePermissions): ManagedNetworkPolicy | undefined {
    const allowedHosts = permissions.network.allowedHosts ?? [];
    const proxyUnrestrictedEgress =
        process.platform === "linux" &&
        permissions.network.egress &&
        !permissions.network.localBinding &&
        allowedHosts.length === 0;
    if (!permissions.network.egress || (allowedHosts.length === 0 && !proxyUnrestrictedEgress)) {
        return undefined;
    }
    return {
        ...(proxyUnrestrictedEgress ? { allowPrivateAddresses: true } : {}),
        allowedDomains: (proxyUnrestrictedEgress ? ["*"] : allowedHosts).map((domain) => ({
            domain,
        })),
    };
}

function usesDirectEgress(permissions: ComputePermissions): boolean {
    return (
        permissions.network.egress &&
        (permissions.network.allowedHosts?.length ?? 0) === 0 &&
        !(process.platform === "linux" && !permissions.network.localBinding)
    );
}

interface CommandCleanupResult {
    errorMessage?: string;
    protectedPathViolation: boolean;
}

/**
 * Tears down the resources a command holds and reports whether a protected path was touched.
 *
 * Each teardown is settled independently so one failure cannot leave another resource leaked, and
 * the protected-path monitor is treated as a violation if it could not report otherwise: failing
 * closed is the safe reading when the backstop itself errored.
 */
async function cleanUpCommandResources(
    protectedPathMonitor: ProtectedPathMonitor,
    managedNetwork: HostManagedNetwork | undefined,
    projectConfigPlaceholders: readonly ProjectConfigPlaceholder[] | undefined,
): Promise<CommandCleanupResult> {
    const [protectedPathResult, managedNetworkResult, projectConfigResult] =
        await Promise.allSettled([
            protectedPathMonitor.stop(),
            managedNetwork?.close() ?? Promise.resolve(),
            Promise.all(
                (projectConfigPlaceholders ?? []).map((placeholder) => placeholder.close()),
            ),
        ]);
    const errors = [
        ...(protectedPathResult.status === "rejected" ? [protectedPathResult.reason] : []),
        ...(managedNetworkResult.status === "rejected" ? [managedNetworkResult.reason] : []),
        ...(projectConfigResult.status === "rejected" ? [projectConfigResult.reason] : []),
    ];
    return {
        ...(errors.length === 0
            ? {}
            : {
                  errorMessage: `Command cleanup failed: ${errors.map(errorToMessage).join("; ")}\n`,
              }),
        protectedPathViolation:
            protectedPathResult.status === "fulfilled" ? protectedPathResult.value : true,
    };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
