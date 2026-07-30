import { isAbsolute, resolve } from "node:path";

import {
    resolveSystemShell,
    type ManagedProcess,
    type NativeProcessManager,
    type ProcessRunResult,
} from "../../processes/index.js";
import type { PermissionContext } from "../../permissions/index.js";
import type { BashContext, BashSessionSnapshot } from "./BashContext.js";
import { assertCanUseCustomShell } from "./assertCanUseCustomShell.js";
import { createSandboxedCommand } from "./createSandboxedCommand.js";
import type { ManagedNetworkProxyHandle } from "./ManagedNetworkPolicy.js";
import { startManagedNetworkProxy } from "./startManagedNetworkProxy.js";
import {
    startLinuxManagedNetworkBridge,
    type LinuxManagedNetworkBridge,
} from "./startLinuxManagedNetworkBridge.js";
import {
    loadProjectManagedNetworkPolicy,
    mergeManagedNetworkPolicies,
} from "./loadProjectManagedNetworkPolicy.js";
import { createProtectedPathMonitor } from "./createProtectedPathMonitor.js";
import { createToolEnvironment } from "./createToolEnvironment.js";
import { waitForBashSessionCompletion } from "./waitForBashSessionCompletion.js";
import { MAX_ACTIVE_BASH_SESSIONS, MAX_RETAINED_BASH_SESSIONS } from "./bashSessionLimits.js";
import { createCommandEnvironment, type SessionSecretContext } from "../../secrets/index.js";

export interface CreateNodeBashContextOptions {
    cwd: string;
    processManager: NativeProcessManager;
    permissions: PermissionContext;
    secrets?: SessionSecretContext;
}

interface NodeBashSession {
    command: string;
    completionWaiters: Set<() => void>;
    cwd: string;
    process: ManagedProcess;
    managedNetwork?: CommandManagedNetwork;
    result?: ProcessRunResult;
    sessionId: number;
    stderrOffset: number;
    stdoutOffset: number;
    timedOut: boolean;
    timeout?: NodeJS.Timeout;
}

export function createNodeBashContext(options: CreateNodeBashContextOptions): BashContext {
    const sessions = new Map<number, NodeBashSession>();
    let nextSessionId = 1;
    let pendingSessionStarts = 0;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    const activeSessionCount = () =>
        [...sessions.values()].filter((session) => session.result === undefined).length;
    const activeSessions = () =>
        [...sessions.values()]
            .filter((session) => session.result === undefined)
            .map((session) => ({
                command: session.command,
                cwd: session.cwd,
                sessionId: session.sessionId,
                status: "running" as const,
            }));
    const reserveSessionStart = () => {
        if (activeSessionCount() + pendingSessionStarts >= MAX_ACTIVE_BASH_SESSIONS) {
            throw new Error(
                `No more than ${String(MAX_ACTIVE_BASH_SESSIONS)} background commands can run at once.`,
            );
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

    const readSession = async (
        sessionId: number,
        readOptions: Parameters<BashContext["readSession"]>[1] = {},
    ): Promise<BashSessionSnapshot | undefined> => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        const waitMs = Math.max(0, readOptions.waitMs ?? 0);
        if (session.result === undefined && waitMs > 0 && !readOptions.signal?.aborted) {
            await waitForBashSessionCompletion(
                session.completionWaiters,
                waitMs,
                readOptions.signal,
            );
        }

        const processSnapshot = session.process.readOutput(
            session.stdoutOffset,
            session.stderrOffset,
        );
        session.stdoutOffset = processSnapshot.stdoutOffset;
        session.stderrOffset = processSnapshot.stderrOffset;
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
            stderr: processSnapshot.stderr,
            stderrDelta: processSnapshot.stderrDelta,
            stdout: processSnapshot.stdout,
            stdoutDelta: processSnapshot.stdoutDelta,
            timedOut: session.timedOut,
        };
    };

    return {
        activeSessionCount,
        activeSessions,
        cwd: options.cwd,
        async interruptSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            return session.process.interrupt();
        },
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => session.result === undefined);
            await Promise.all(
                active.map((session) => session.process.kill("SIGTERM", { forceAfterMs: 500 })),
            );
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            await session.process.kill("SIGTERM", { forceAfterMs: 500 });
            return readSession(sessionId);
        },
        readSession,
        async run(runOptions) {
            assertCanUseCustomShell(options.permissions.mode, runOptions.shell);
            const cwd = runCwd(runOptions.cwd);
            const shell = runOptions.shell ?? resolveSystemShell();
            const toolEnvironment = await createToolEnvironment(
                options.permissions.mode,
                globalThis.process.env,
                { cwd: options.cwd },
            );
            const networkPolicy = mergeManagedNetworkPolicies(
                await loadProjectManagedNetworkPolicy(options.cwd),
                runOptions.network,
            );
            const managedNetwork = await startCommandManagedNetwork(networkPolicy);
            let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
            try {
                sandboxedCommand = await createSandboxedCommand({
                    command: runOptions.command,
                    commandCwd: cwd,
                    cwd: options.cwd,
                    mode: options.permissions.mode,
                    ...networkSandboxOptions(networkPolicy, managedNetwork),
                    ...(toolEnvironment.PATH === undefined ? {} : { path: toolEnvironment.PATH }),
                    shell,
                });
            } catch (error) {
                await managedNetwork?.close();
                throw error;
            }
            const processRunOptions: Parameters<NativeProcessManager["run"]>[0] = {
                command: sandboxedCommand.command,
                cwd,
                env: withManagedNetworkProxy(
                    createCommandEnvironment(toolEnvironment, options.secrets, runOptions.secrets),
                    managedNetwork,
                    networkPolicy,
                ),
                timeoutMs: runOptions.timeoutMs ?? 120_000,
                maxOutputBytes: runOptions.maxOutputBytes ?? 512_000,
            };
            if (sandboxedCommand.args !== undefined) {
                processRunOptions.args = sandboxedCommand.args;
            } else {
                processRunOptions.shell = shell;
            }
            if (runOptions.signal !== undefined) processRunOptions.signal = runOptions.signal;

            const protectedPathMonitor = await createProtectedPathMonitor(
                sandboxedCommand.protectedCreatePaths ?? [],
            );
            let result: ProcessRunResult;
            let protectedPathViolation = false;
            try {
                result = await options.processManager.run(processRunOptions);
            } finally {
                protectedPathViolation = await protectedPathMonitor.stop();
                await managedNetwork?.close();
            }
            return {
                stdout: result.stdout,
                stderr:
                    protectedPathViolation && result.exitCode === 0
                        ? `${result.stderr}Sandbox blocked creation of protected agent metadata.\n`
                        : result.stderr,
                exitCode: protectedPathViolation && result.exitCode === 0 ? 1 : result.exitCode,
                timedOut: result.timedOut,
            };
        },
        async startSession(runOptions) {
            const releaseSessionStart = reserveSessionStart();
            try {
                assertCanUseCustomShell(options.permissions.mode, runOptions.shell);
                const cwd = runCwd(runOptions.cwd);
                const shell = runOptions.shell ?? resolveSystemShell();
                const toolEnvironment = await createToolEnvironment(
                    options.permissions.mode,
                    globalThis.process.env,
                    { cwd: options.cwd },
                );
                const networkPolicy = mergeManagedNetworkPolicies(
                    await loadProjectManagedNetworkPolicy(options.cwd),
                    runOptions.network,
                );
                const managedNetwork = await startCommandManagedNetwork(networkPolicy);
                let sandboxedCommand: Awaited<ReturnType<typeof createSandboxedCommand>>;
                try {
                    sandboxedCommand = await createSandboxedCommand({
                        command: runOptions.command,
                        commandCwd: cwd,
                        cwd: options.cwd,
                        mode: options.permissions.mode,
                        ...networkSandboxOptions(networkPolicy, managedNetwork),
                        ...(toolEnvironment.PATH === undefined
                            ? {}
                            : { path: toolEnvironment.PATH }),
                        shell,
                    });
                } catch (error) {
                    await managedNetwork?.close();
                    throw error;
                }
                const processStartOptions: Parameters<NativeProcessManager["start"]>[0] = {
                    cleanupProcessGroupOnExit: true,
                    command: sandboxedCommand.command,
                    cwd,
                    env: withManagedNetworkProxy(
                        createCommandEnvironment(
                            toolEnvironment,
                            options.secrets,
                            runOptions.secrets,
                        ),
                        managedNetwork,
                        networkPolicy,
                    ),
                    maxOutputBytes: runOptions.maxOutputBytes ?? 512_000,
                };
                if (sandboxedCommand.args !== undefined) {
                    processStartOptions.args = sandboxedCommand.args;
                } else {
                    processStartOptions.shell = shell;
                }
                const protectedPathMonitor = await createProtectedPathMonitor(
                    sandboxedCommand.protectedCreatePaths ?? [],
                );
                let process: ManagedProcess;
                try {
                    process = options.processManager.start(processStartOptions);
                } catch (error) {
                    await protectedPathMonitor.stop();
                    await managedNetwork?.close();
                    throw error;
                }
                const completion = process.wait();
                const sessionId = nextSessionId;
                nextSessionId += 1;
                const session: NodeBashSession = {
                    command: runOptions.command,
                    completionWaiters: new Set(),
                    cwd,
                    process,
                    ...(managedNetwork === undefined ? {} : { managedNetwork }),
                    sessionId,
                    stderrOffset: 0,
                    stdoutOffset: 0,
                    timedOut: false,
                };
                sessions.set(sessionId, session);
                onActiveSessionCountChange?.(activeSessionCount());
                if (runOptions.timeoutMs !== undefined) {
                    session.timeout = setTimeout(() => {
                        session.timedOut = true;
                        void process.kill("SIGTERM", { forceAfterMs: 500 });
                    }, runOptions.timeoutMs);
                    session.timeout.unref();
                }
                void completion.then(async (result) => {
                    const protectedPathViolation = await protectedPathMonitor.stop();
                    await managedNetwork?.close();
                    session.result =
                        protectedPathViolation && result.exitCode === 0
                            ? {
                                  ...result,
                                  exitCode: 1,
                                  stderr: `${result.stderr}Sandbox blocked creation of protected agent metadata.\n`,
                              }
                            : result;
                    if (session.timeout !== undefined) clearTimeout(session.timeout);
                    for (const finish of session.completionWaiters) finish();
                    onActiveSessionCountChange?.(activeSessionCount());
                });
                if (sessions.size > MAX_RETAINED_BASH_SESSIONS) {
                    const completed = [...sessions.values()].find(
                        (candidate) => candidate.result !== undefined,
                    );
                    if (completed !== undefined) sessions.delete(completed.sessionId);
                }
                return sessionId;
            } finally {
                releaseSessionStart();
            }
        },
        setActiveSessionCountListener(listener) {
            onActiveSessionCountChange = listener;
            listener?.(activeSessionCount());
        },
        supportsSessionInput: true,
        async writeSession(sessionId, data) {
            const session = sessions.get(sessionId);
            return session?.process.writeStdin(data) ?? false;
        },
    };
}

interface CommandManagedNetwork {
    bridge?: LinuxManagedNetworkBridge;
    close(): Promise<void>;
    proxy?: ManagedNetworkProxyHandle;
}

async function startCommandManagedNetwork(
    policy: import("./ManagedNetworkPolicy.js").ManagedNetworkPolicy | undefined,
): Promise<CommandManagedNetwork | undefined> {
    if (policy === undefined) return undefined;
    if (process.platform !== "darwin" && process.platform !== "linux")
        throw new Error("Managed network access is currently supported only on macOS and Linux.");
    if (
        (policy.allowedDomains?.length ?? 0) === 0 &&
        (policy.allowedLoopbackPorts?.length ?? 0) === 0
    ) {
        throw new Error(
            "Managed network access requires an allowed domain or an allowed loopback port.",
        );
    }
    validateLoopbackPorts(policy.allowedLoopbackPorts ?? []);
    if ((policy.allowedDomains?.length ?? 0) === 0 && process.platform !== "linux")
        return { close: async () => {} };
    const proxy = await startManagedNetworkProxy(policy);
    try {
        const bridge =
            process.platform === "linux"
                ? await startLinuxManagedNetworkBridge(proxy, {
                      ...(policy.allowedLoopbackPorts === undefined
                          ? {}
                          : { loopbackPorts: policy.allowedLoopbackPorts }),
                  })
                : undefined;
        return {
            ...(bridge === undefined ? {} : { bridge }),
            proxy,
            async close() {
                await bridge?.close();
                await proxy.close();
            },
        };
    } catch (error) {
        await proxy.close();
        throw error;
    }
}

function networkSandboxOptions(
    policy: import("./ManagedNetworkPolicy.js").ManagedNetworkPolicy | undefined,
    managedNetwork: CommandManagedNetwork | undefined,
): {
    networkAllowedLoopbackPorts?: readonly number[];
    networkUnixProxySockets?: {
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
} {
    const proxy = managedNetwork?.proxy;
    const ports = [
        ...(policy?.allowedLoopbackPorts ?? []),
        ...(proxy === undefined ? [] : [proxy.port, proxy.socksPort]),
    ];
    return {
        ...(ports.length === 0 ? {} : { networkAllowedLoopbackPorts: [...new Set(ports)] }),
        ...(managedNetwork?.bridge === undefined
            ? {}
            : {
                  networkUnixProxySockets: {
                      http: managedNetwork.bridge.httpSocketPath,
                      loopback: managedNetwork.bridge.loopbackSockets,
                      socks: managedNetwork.bridge.socksSocketPath,
                  },
              }),
    };
}

function validateLoopbackPorts(ports: readonly number[]): void {
    for (const port of ports) {
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
            throw new Error(`Invalid managed network loopback port: ${String(port)}`);
        }
    }
}

function withManagedNetworkProxy(
    environment: NodeJS.ProcessEnv,
    managedNetwork: CommandManagedNetwork | undefined,
    policy: import("./ManagedNetworkPolicy.js").ManagedNetworkPolicy | undefined,
): NodeJS.ProcessEnv {
    const proxy = managedNetwork?.proxy;
    if (proxy === undefined) return environment;
    const bridge = managedNetwork?.bridge;
    const url =
        bridge === undefined ? `http://127.0.0.1:${String(proxy.port)}` : "http://127.0.0.1:3128";
    const socksUrl =
        bridge === undefined
            ? `socks5h://127.0.0.1:${String(proxy.socksPort)}`
            : "socks5h://127.0.0.1:1080";
    const noProxy =
        (policy?.allowedLoopbackPorts?.length ?? 0) > 0 ? "localhost,127.0.0.1,::1" : "";
    return {
        ...environment,
        ALL_PROXY: socksUrl,
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: noProxy,
        all_proxy: socksUrl,
        http_proxy: url,
        https_proxy: url,
        no_proxy: noProxy,
    };
}
