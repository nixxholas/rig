import { isAbsolute, resolve } from "node:path";
import type { Context } from "@steve.kite/stdlib";

import {
    resolveSystemShell,
    type ManagedProcess,
    type NativeProcessManager,
    type ProcessRunResult,
    type ProcessRunOptions,
    type ProcessStartOptions,
} from "../../processes/index.js";
import { assertPermissionRevision, type PermissionContext } from "../../permissions/index.js";
import type { BashContext, BashSessionExit, BashSessionSnapshot } from "./BashContext.js";
import { assertCanUseCustomShell } from "./assertCanUseCustomShell.js";
import { createSandboxedCommand } from "./createSandboxedCommand.js";
import {
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkInterceptor,
    type ManagedNetworkPolicy,
    shouldApplyManagedNetworkPolicy,
} from "./ManagedNetworkPolicy.js";
import {
    type SandboxedProcessNetwork,
    startSandboxedProcessNetwork,
} from "./startSandboxedProcessNetwork.js";
import { loadProjectManagedNetworkPolicy } from "./loadProjectManagedNetworkPolicy.js";
import {
    createProtectedPathMonitor,
    type ProtectedPathMonitor,
} from "./createProtectedPathMonitor.js";
import type { ProjectConfigPlaceholder } from "./prepareProjectConfigPlaceholder.js";
import { createToolEnvironment } from "./createToolEnvironment.js";
import { waitForBashSessionCompletion } from "./waitForBashSessionCompletion.js";
import {
    BASH_SESSION_STOP_GRACE_MS,
    MAX_ACTIVE_BASH_SESSIONS,
    MAX_RETAINED_BASH_SESSIONS,
} from "./bashSessionLimits.js";
import { createCommandEnvironment, type SessionSecretContext } from "../../secrets/index.js";
import { errorToMessage } from "../../errorToMessage.js";
import { formatManagedNetworkDenial } from "./formatManagedNetworkDenial.js";
import { redactGitAuthenticationText } from "../../git/GitCredentialBroker.js";
import { assertCanUseCommandSecrets } from "./assertCanUseCommandSecrets.js";

export interface CreateNodeBashContextOptions {
    ctx: Context;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    loadManagedNetworkPolicy?: typeof loadProjectManagedNetworkPolicy;
    networkInterceptor?: ManagedNetworkInterceptor;
    processManager: NativeProcessManager;
    permissions: PermissionContext;
    secrets?: SessionSecretContext;
    startManagedNetwork?: (
        policy: ManagedNetworkPolicy | undefined,
    ) => Promise<
        | (Pick<SandboxedProcessNetwork, "close" | "proxy"> &
              Partial<Pick<SandboxedProcessNetwork, "sandboxOptions" | "withProxyEnvironment">>)
        | undefined
    >;
}

interface NodeBashSession {
    command: string;
    completionStderrDelta?: string;
    completionWaiters: Set<() => void>;
    /**
     * Readers waiting for the end who will also report it.
     *
     * An observer that only peeks waits the same way but consumes nothing, so
     * it must not be mistaken for someone about to tell the model the news.
     */
    consumingWaiters: number;
    cwd: string;
    /** Stopped to make room for a newer command, but still readable. */
    evicted?: true;
    /** A read has already returned this session's final status. */
    exitObserved: boolean;
    process: ManagedProcess;
    redactionEnvironment: NodeJS.ProcessEnv;
    managedNetwork?: SandboxedProcessNetwork;
    result?: ProcessRunResult;
    sessionId: number;
    stderrOffset: number;
    stdoutOffset: number;
    timedOut: boolean;
    usesSecrets: boolean;
}

export function createNodeBashContext(options: CreateNodeBashContextOptions): BashContext {
    const sessions = new Map<number, NodeBashSession>();
    let nextSessionId = 1;
    let pendingSessionStarts = 0;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: BashSessionExit) => void | Promise<void>) | undefined;
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
    /**
     * Makes room for one more command. Running out of slots is our problem, not
     * the model's, so the oldest command is evicted to free one.
     *
     * The evicted session stays readable: it is stopped, not forgotten, so a
     * model still holding its task ID learns what became of it. Only its slot
     * is released, and immediately, so a command that ignores the signal cannot
     * keep the next one from starting.
     */
    const reserveSessionStart = () => {
        while (activeSessionCount() + pendingSessionStarts >= MAX_ACTIVE_BASH_SESSIONS) {
            const oldest = [...sessions.values()]
                .filter((session) => session.result === undefined && !session.evicted)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) {
                throw new Error(
                    `No more than ${String(MAX_ACTIVE_BASH_SESSIONS)} background commands can run at once.`,
                );
            }
            oldest.evicted = true;
            void oldest.process.kill(options.ctx, "SIGTERM", {
                forceAfterMs: BASH_SESSION_STOP_GRACE_MS,
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
    const runCwd = (cwd: string | undefined) =>
        cwd === undefined ? options.cwd : isAbsolute(cwd) ? cwd : resolve(options.cwd, cwd);
    const loadManagedNetworkPolicy =
        options.loadManagedNetworkPolicy ?? loadProjectManagedNetworkPolicy;
    const startManagedNetwork =
        options.startManagedNetwork === undefined
            ? (policy: ManagedNetworkPolicy | undefined) =>
                  startSandboxedProcessNetwork(policy, {
                      ...(options.networkInterceptor === undefined
                          ? {}
                          : { networkInterceptor: options.networkInterceptor }),
                  })
            : async (policy: ManagedNetworkPolicy | undefined) => {
                  const managedNetwork = await options.startManagedNetwork?.(policy);
                  if (managedNetwork === undefined) return undefined;
                  return {
                      sandboxOptions: managedNetwork.sandboxOptions ?? {},
                      ...(managedNetwork.proxy === undefined
                          ? {}
                          : { proxy: managedNetwork.proxy }),
                      close: () => managedNetwork.close(),
                      withProxyEnvironment(environment: NodeJS.ProcessEnv) {
                          return managedNetwork.withProxyEnvironment?.(environment) ?? environment;
                      },
                  };
              };

    /**
     * Forgets the oldest finished commands once too many have piled up.
     *
     * Runs whenever a command starts or ends, so a session that only ever
     * finishes work still lets go of what it is holding.
     */
    const trimFinishedSessions = () => {
        while (sessions.size > MAX_RETAINED_BASH_SESSIONS) {
            const finished = [...sessions.values()]
                .filter((candidate) => candidate.result !== undefined)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            sessions.delete(finished.sessionId);
        }
    };
    const readSession = async (
        sessionId: number,
        readOptions: Parameters<BashContext["readSession"]>[1] = {},
    ): Promise<BashSessionSnapshot | undefined> => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        const waitMs = Math.max(0, readOptions.waitMs ?? 0);
        const peeking = readOptions.peek === true;
        if (session.result === undefined && waitMs > 0 && !readOptions.signal?.aborted) {
            if (!peeking) session.consumingWaiters += 1;
            try {
                await waitForBashSessionCompletion(
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
        const redact = (text: string) =>
            redactGitAuthenticationText(text, session.redactionEnvironment);
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
            stderr: redact(session.result?.stderr ?? processSnapshot.stderr),
            stderrDelta: redact(stderrDelta),
            ...(processSnapshot.stderrBytes === undefined
                ? {}
                : { stderrBytes: processSnapshot.stderrBytes }),
            ...(processSnapshot.stderrOmittedBytes === undefined
                ? {}
                : { stderrOmittedBytes: processSnapshot.stderrOmittedBytes }),
            stderrDeltaBytes,
            stderrDeltaOmittedBytes: processSnapshot.stderrDeltaOmittedBytes ?? 0,
            stdout: redact(session.result?.stdout ?? processSnapshot.stdout),
            stdoutDelta: redact(processSnapshot.stdoutDelta),
            ...(processSnapshot.stdoutBytes === undefined
                ? {}
                : { stdoutBytes: processSnapshot.stdoutBytes }),
            ...(processSnapshot.stdoutOmittedBytes === undefined
                ? {}
                : { stdoutOmittedBytes: processSnapshot.stdoutOmittedBytes }),
            stdoutDeltaBytes,
            stdoutDeltaOmittedBytes: processSnapshot.stdoutDeltaOmittedBytes ?? 0,
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
            // Everything is being taken down at once, by us. Telling the model
            // about each casualty afterwards would say nothing it does not know.
            for (const session of active) session.exitObserved = true;
            await Promise.all(
                active.map((session) =>
                    session.process.kill(options.ctx, "SIGTERM", {
                        forceAfterMs: BASH_SESSION_STOP_GRACE_MS,
                    }),
                ),
            );
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            // Whoever stopped the command is told how it ended by this very
            // call, so claim the outcome before the exit continuation can run
            // and announce it a second time.
            session.exitObserved = true;
            await session.process.kill(options.ctx, "SIGTERM", {
                forceAfterMs: BASH_SESSION_STOP_GRACE_MS,
            });
            // The process is gone, but this session records the outcome from a
            // separate continuation. Wait for that before reporting status,
            // otherwise a just-killed command still reads as running.
            if (session.result === undefined) {
                await waitForBashSessionCompletion(session.completionWaiters, 5_000);
            }
            // Stopping a command reports its status; it must not swallow output
            // the model has not read yet.
            return readSession(sessionId, { peek: true });
        },
        readSession,
        async run(runOptions) {
            const permissionMode = options.permissions.mode;
            const permissionRevision = options.permissions.revision;
            assertCanUseCustomShell(permissionMode, runOptions.shell);
            assertCanUseCommandSecrets(permissionMode, runOptions.secrets);
            const cwd = runCwd(runOptions.cwd);
            const shell = runOptions.shell ?? resolveSystemShell(options.environment);
            const toolEnvironment = await createToolEnvironment(
                permissionMode,
                options.environment,
                { cwd: options.cwd },
            );
            const networkPolicy = shouldApplyManagedNetworkPolicy(permissionMode)
                ? await loadManagedNetworkPolicy(options.cwd)
                : undefined;
            const managedNetwork = await startManagedNetwork(networkPolicy);
            let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
            try {
                sandboxedCommand = await createSandboxedCommand({
                    command: runOptions.command,
                    commandCwd: cwd,
                    cwd: options.cwd,
                    mode: permissionMode,
                    protectedPaths: options.permissions.protectedPaths,
                    ...managedNetwork?.sandboxOptions,
                    ...(toolEnvironment.PATH === undefined ? {} : { path: toolEnvironment.PATH }),
                    shell,
                });
            } catch (error) {
                await managedNetwork?.close();
                throw error;
            }
            const activatedSecrets = options.secrets?.activate(runOptions.secrets) ?? {
                environment: {},
                release: () => {},
            };
            let commandEnvironment: NodeJS.ProcessEnv;
            try {
                commandEnvironment = createCommandEnvironment(
                    toolEnvironment,
                    options.secrets,
                    runOptions.secrets,
                    activatedSecrets.environment,
                );
            } catch (error) {
                activatedSecrets.release();
                await managedNetwork?.close();
                throw error;
            }
            const processRunOptions: ProcessRunOptions = {
                command: sandboxedCommand.command,
                cwd,
                env: managedNetwork?.withProxyEnvironment(commandEnvironment) ?? commandEnvironment,
                timeoutMs: runOptions.timeoutMs ?? 120_000,
                maxOutputBytes: runOptions.maxOutputBytes ?? 512_000,
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
                activatedSecrets.release();
                await cleanUpCommandResources(
                    { stop: async () => false },
                    managedNetwork,
                    sandboxedCommand.projectConfigPlaceholder,
                );
                throw error;
            }
            let result: ProcessRunResult;
            let cleanup: CommandCleanupResult = { protectedPathViolation: false };
            try {
                assertPermissionRevision(options.permissions, permissionRevision);
                result = await options.processManager.run(options.ctx, processRunOptions);
            } finally {
                activatedSecrets.release();
                stopObservingNetworkDenials?.();
                runOptions.signal?.removeEventListener("abort", abortFromCaller);
                cleanup = await cleanUpCommandResources(
                    protectedPathMonitor,
                    managedNetwork,
                    sandboxedCommand.projectConfigPlaceholder,
                );
            }
            const protectedPathMessage =
                cleanup.protectedPathViolation && result.exitCode === 0
                    ? "Sandbox blocked creation of protected agent metadata.\n"
                    : "";
            const networkDenialMessage =
                networkDenial === undefined ? "" : formatManagedNetworkDenial(networkDenial);
            return {
                stdout: redactGitAuthenticationText(result.stdout, commandEnvironment),
                stderr: redactGitAuthenticationText(
                    `${result.stderr}${networkDenialMessage}${protectedPathMessage}${cleanup.errorMessage ?? ""}`,
                    commandEnvironment,
                ),
                exitCode:
                    networkDenial !== undefined ||
                    cleanup.errorMessage !== undefined ||
                    (cleanup.protectedPathViolation && result.exitCode === 0)
                        ? 1
                        : result.exitCode,
                timedOut: result.timedOut,
            };
        },
        async startSession(runOptions) {
            // Validate before making room: a command that is never going to
            // start must not cost the user a running one.
            const permissionMode = options.permissions.mode;
            assertCanUseCustomShell(permissionMode, runOptions.shell);
            assertCanUseCommandSecrets(permissionMode, runOptions.secrets);
            const releaseSessionStart = reserveSessionStart();
            try {
                const permissionRevision = options.permissions.revision;
                const cwd = runCwd(runOptions.cwd);
                const shell = runOptions.shell ?? resolveSystemShell(options.environment);
                const toolEnvironment = await createToolEnvironment(
                    permissionMode,
                    options.environment,
                    { cwd: options.cwd },
                );
                const networkPolicy = shouldApplyManagedNetworkPolicy(permissionMode)
                    ? await loadManagedNetworkPolicy(options.cwd)
                    : undefined;
                const managedNetwork = await startManagedNetwork(networkPolicy);
                let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
                try {
                    sandboxedCommand = await createSandboxedCommand({
                        command: runOptions.command,
                        commandCwd: cwd,
                        cwd: options.cwd,
                        mode: permissionMode,
                        protectedPaths: options.permissions.protectedPaths,
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
                const activatedSecrets = options.secrets?.activate(runOptions.secrets) ?? {
                    environment: {},
                    release: () => {},
                };
                let commandEnvironment: NodeJS.ProcessEnv;
                try {
                    commandEnvironment = createCommandEnvironment(
                        toolEnvironment,
                        options.secrets,
                        runOptions.secrets,
                        activatedSecrets.environment,
                    );
                } catch (error) {
                    activatedSecrets.release();
                    await managedNetwork?.close();
                    throw error;
                }
                const processStartOptions: ProcessStartOptions = {
                    command: sandboxedCommand.command,
                    cwd,
                    env:
                        managedNetwork?.withProxyEnvironment(commandEnvironment) ??
                        commandEnvironment,
                    maxOutputBytes: runOptions.maxOutputBytes ?? 512_000,
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
                    activatedSecrets.release();
                    await cleanUpCommandResources(
                        { stop: async () => false },
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholder,
                    );
                    throw error;
                }
                let process: ManagedProcess;
                try {
                    assertPermissionRevision(options.permissions, permissionRevision);
                    process = await options.processManager.start(options.ctx, processStartOptions);
                } catch (error) {
                    activatedSecrets.release();
                    await cleanUpCommandResources(
                        protectedPathMonitor,
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholder,
                    );
                    throw error;
                }
                const completion = process.wait(options.ctx);
                const sessionId = nextSessionId;
                nextSessionId += 1;
                const session: NodeBashSession = {
                    command: runOptions.command,
                    completionWaiters: new Set(),
                    consumingWaiters: 0,
                    cwd,
                    exitObserved: false,
                    process,
                    redactionEnvironment: commandEnvironment,
                    ...(managedNetwork === undefined ? {} : { managedNetwork }),
                    sessionId,
                    stderrOffset: 0,
                    stdoutOffset: 0,
                    timedOut: false,
                    usesSecrets: (runOptions.secrets?.length ?? 0) > 0,
                };
                let networkDenial: ManagedNetworkBlockedRequest | undefined;
                const stopObservingNetworkDenials = managedNetwork?.proxy?.onBlockedRequest(
                    (request) => {
                        networkDenial ??= request;
                        void process.kill(options.ctx, "SIGTERM", {
                            forceAfterMs: BASH_SESSION_STOP_GRACE_MS,
                        });
                    },
                );
                sessions.set(sessionId, session);
                onActiveSessionCountChange?.(activeSessionCount());
                void completion.then(async (result) => {
                    activatedSecrets.release();
                    stopObservingNetworkDenials?.();
                    const cleanup = await cleanUpCommandResources(
                        protectedPathMonitor,
                        managedNetwork,
                        sandboxedCommand.projectConfigPlaceholder,
                    );
                    const protectedPathMessage =
                        cleanup.protectedPathViolation && result.exitCode === 0
                            ? "Sandbox blocked creation of protected agent metadata.\n"
                            : "";
                    const networkDenialMessage =
                        networkDenial === undefined
                            ? ""
                            : formatManagedNetworkDenial(networkDenial);
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
                    // Nobody was waiting on this command, so nobody is about to
                    // learn that it ended. Say so, without the output.
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
        sessionUsesSecrets(sessionId) {
            return sessions.get(sessionId)?.usesSecrets === true;
        },
        supportsSessionInput: true,
        async writeSession(sessionId, data) {
            const session = sessions.get(sessionId);
            if (session?.usesSecrets === true) {
                assertCanUseCommandSecrets(options.permissions.mode, ["selected"]);
            }
            return session?.process.writeStdin(options.ctx, data) ?? false;
        },
    };
}

interface CommandCleanupResult {
    errorMessage?: string;
    protectedPathViolation: boolean;
}

async function cleanUpCommandResources(
    protectedPathMonitor: ProtectedPathMonitor,
    managedNetwork: SandboxedProcessNetwork | undefined,
    projectConfigPlaceholder: ProjectConfigPlaceholder | undefined,
): Promise<CommandCleanupResult> {
    const [protectedPathResult, managedNetworkResult, projectConfigResult] =
        await Promise.allSettled([
            protectedPathMonitor.stop(),
            managedNetwork?.close() ?? Promise.resolve(),
            projectConfigPlaceholder?.close() ?? Promise.resolve(),
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
