import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { posix } from "node:path";
import { PassThrough, type Duplex } from "node:stream";

import type Dockerode from "dockerode";

import { EMPTY_COMPUTE_HOST_POLICY, type ComputeHostPolicy } from "../ComputeHostPolicy.js";
import { assertComputePermissions, type ComputePermissions } from "../ComputePermissions.js";
import type {
    ComputeRunOptions,
    ComputeRunResult,
    ComputeSessionActivity,
    ComputeSessionExit,
    ComputeSessionSnapshot,
    ComputeShell,
} from "../ComputeShell.js";
import { formatManagedNetworkDenial } from "../network/impl/formatManagedNetworkDenial.js";
import {
    validateManagedNetworkLoopbackPorts,
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkInterceptor,
    type ManagedNetworkPolicy,
    type ManagedNetworkProxyHandle,
} from "../network/ManagedNetworkPolicy.js";
import {
    startLinuxManagedNetworkBridge,
    type LinuxManagedNetworkBridge,
} from "../network/startLinuxManagedNetworkBridge.js";
import { startManagedNetworkProxy } from "../network/startManagedNetworkProxy.js";
import { runCleanupSteps } from "../sandbox/impl/runCleanupSteps.js";
import { BoundedOutputBuffer } from "../processes/index.js";
import { createDockerSandboxCommand } from "./impl/createDockerSandboxCommand.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";
import { DOCKER_PROTECTED_PATH_MONITOR_SCRIPT } from "./impl/dockerProtectedPathMonitorScript.js";
import { errorToMessage } from "./impl/errorToMessage.js";
import {
    cleanupDockerNetworkPolicyPlaceholder,
    loadDockerProjectManagedNetworkPolicyState,
    type ParseDockerProjectNetworkConfig,
} from "./impl/loadDockerProjectManagedNetworkPolicy.js";
import { prepareDockerNetworkBridgeContainerRoot } from "./impl/prepareDockerNetworkBridgeContainerRoot.js";
import {
    DOCKER_NETWORK_BRIDGE_DIRECTORY,
    prepareDockerNetworkBridgeHostRoot,
} from "./impl/prepareDockerNetworkBridgeHostRoot.js";
import { prepareDockerSandbox, type PreparedDockerSandbox } from "./impl/prepareDockerSandbox.js";
import { resolveDockerBindMountPath } from "./impl/resolveDockerBindMountPath.js";
import { resolveDockerNetworkPermissions } from "./impl/resolveDockerNetworkPermissions.js";
import {
    dockerNetworkPolicyFileNames,
    dockerProtectedProjectFileNames,
    dockerReadableDirectories,
    resolveDockerPrivateDirectories,
    snapshotDockerHostPolicy,
} from "./impl/resolveDockerHostPolicy.js";
import { resolveDockerPath } from "./impl/resolveDockerPath.js";
import { runDockerExec } from "./impl/runDockerExec.js";

/** How the Docker shell is wired to the layer above it. */
export interface DockerShellOptions {
    /** Environment variables injected into every command, such as the session's Git identity. */
    baseEnvironment?: Readonly<Record<string, string>>;
    /** Product-owned paths and root project files this shell must protect. */
    hostPolicy?: ComputeHostPolicy;
    /** An optional HTTP interceptor consulted by the managed proxy. */
    networkInterceptor?: ManagedNetworkInterceptor;
    /** Interprets a project config file into a managed-network configuration; see the type. */
    parseNetworkConfig?: ParseDockerProjectNetworkConfig;
}

interface DockerShellSession {
    command: string;
    completion: Promise<void>;
    consumingWaiters: number;
    cwd: string;
    /** Stopped to make room for a newer command, but still readable. */
    evicted?: true;
    exec: Dockerode.Exec;
    exitCode: number | null;
    exitObserved: boolean;
    finished: boolean;
    killed: boolean;
    managedNetwork?: DockerManagedNetwork;
    networkDenial?: ManagedNetworkBlockedRequest;
    pidFile: string;
    networkPolicyPlaceholderCleanup?: () => Promise<void>;
    sessionId: number;
    stderr: BoundedOutputBuffer;
    stderrUnread: BoundedOutputBuffer;
    stderrOffset: number;
    stdout: BoundedOutputBuffer;
    stdoutUnread: BoundedOutputBuffer;
    stdoutOffset: number;
    stream: Duplex;
    stopNetworkDenialListener?: () => void;
    timedOut: boolean;
    timeout?: NodeJS.Timeout;
}

interface DockerManagedNetwork {
    authenticationToken: string;
    bridge: LinuxManagedNetworkBridge;
    close(): Promise<void>;
    containerHttpSocketPath: string;
    containerLoopbackSockets: readonly { path: string; port: number }[];
    containerSocksSocketPath: string;
    proxy: ManagedNetworkProxyHandle;
}

const MAX_ACTIVE_SESSIONS = 64;
const MAX_RETAINED_SESSIONS = 64;
// How long a command has to shut itself down before it is forced; long enough to be polite, short
// enough that stopping still feels immediate.
const BASH_SESSION_STOP_GRACE_MS = 2_000;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DOCKER_EXEC_INSPECT_TIMEOUT_MS = 10_000;
// The wrapper writes its own PID, then waits for this token before exec'ing the command, so the
// backend has a PID to signal even for a command that is slow to start.
const DOCKER_EXEC_START_GATE = "compute-start\n";
const DOCKER_EXEC_START_GATE_SCRIPT = String.raw`
pid_file=$1
shift
printf '%s\n' "$$" > "$pid_file"
IFS= read -r gate
[ "$gate" = "compute-start" ] || exit 125
exec "$@"
`;

/**
 * A {@link ComputeShell} whose commands run inside one container as long-lived sessions.
 *
 * A command runs to completion within its timeout or becomes a session the agent comes back to:
 * reaching the timeout backgrounds it, it never kills it. Sessions outlive the tool call and the
 * turn, belong to this shell, and are ended only by disposing the compute. Delta reads return only
 * what accumulated since the previous read, stdin is written straight into the command, stopping is
 * graceful then forceful across the whole process tree, an unobserved exit is reported once, and
 * passing the session cap evicts the oldest command rather than failing the agent's. Restricted
 * commands are wrapped by {@link createDockerSandboxCommand} and reach allowed egress only through
 * the managed-network bridge.
 */
export function createDockerShell(
    environment: DockerEnvironment,
    options: DockerShellOptions = {},
): ComputeShell {
    const baseEnvironment = options.baseEnvironment ?? {};
    const hostPolicy = snapshotDockerHostPolicy(options.hostPolicy ?? EMPTY_COMPUTE_HOST_POLICY);
    const networkPolicyFiles = dockerNetworkPolicyFileNames(hostPolicy);
    const protectedProjectFiles = dockerProtectedProjectFileNames(hostPolicy);
    const readableDirectories = dockerReadableDirectories(hostPolicy);
    const sessions = new Map<number, DockerShellSession>();
    const contextId = randomUUID();
    const cwd = environment.config.workingDirectory;
    let nextSessionId = 1;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;
    let canonicalWorkspace: Promise<string> | undefined;
    let sandboxRuntime: Promise<PreparedDockerSandbox> | undefined;
    const activeSessionCount = () =>
        [...sessions.values()].filter((session) => !session.finished && !session.evicted).length;

    const start = async (
        runOptions: Omit<ComputeRunOptions, "signal">,
        exitObserved = false,
    ): Promise<DockerShellSession> => {
        assertComputePermissions(runOptions.permissions);
        const permissions = snapshotPermissions(runOptions.permissions);
        const permissionMode = permissions.mode;
        if (runOptions.shell !== undefined && permissionMode !== "full_access") {
            throw new Error("Custom shells are available only in Full access mode.");
        }
        assertNoSecrets(runOptions.secrets);
        if (runOptions.tty === true) {
            throw new Error("The Docker backend does not run commands under a pseudo-terminal.");
        }
        const sessionId = nextSessionId++;
        const runCwd = runOptions.cwd === undefined ? cwd : posix.resolve(cwd, runOptions.cwd);
        const shell = runOptions.shell ?? "/bin/sh";
        const pidFile = `/tmp/compute-exec-${process.pid}-${contextId}-${sessionId}.pid`;
        const container = await environment.container();
        const hostPrivateDirectories =
            permissionMode === "full_access"
                ? []
                : await resolveDockerPrivateDirectories(environment, hostPolicy, baseEnvironment);
        const hostDeniedWritePaths =
            permissionMode === "full_access"
                ? []
                : [...hostPrivateDirectories, ...readableDirectories];
        const protectsProjectMetadata =
            permissionMode !== "full_access" && permissionMode !== "read_only";
        const requestedNetwork = resolveDockerNetworkPermissions(permissions);
        const usesProjectNetworkPolicy =
            protectsProjectMetadata &&
            networkPolicyFiles.length > 0 &&
            options.parseNetworkConfig !== undefined;
        const directEgress = requestedNetwork.directEgress && !usesProjectNetworkPolicy;
        const needsSandbox =
            permissionMode !== "full_access" ||
            permissions.deniedReadPaths !== undefined ||
            permissions.deniedWritePaths !== undefined ||
            !directEgress ||
            !permissions.network.localBinding;
        const runtime = needsSandbox ? await loadSandboxRuntime(container) : undefined;
        const workspaceCwd = needsSandbox ? await loadCanonicalWorkspace() : undefined;
        const requestedNetworkPolicy =
            requestedNetwork.managedPolicy ??
            (permissions.network.egress && usesProjectNetworkPolicy
                ? { allowedDomains: [{ domain: "*" }] }
                : undefined);
        const needsNetworkBridge =
            (protectsProjectMetadata && networkPolicyFiles.length > 0) ||
            (requestedNetworkPolicy !== undefined &&
                ((requestedNetworkPolicy.allowedDomains?.length ?? 0) > 0 ||
                    (requestedNetworkPolicy.allowedLoopbackPorts?.length ?? 0) > 0));
        const containerNetworkBridgeRoot = needsNetworkBridge
            ? await prepareDockerNetworkBridgeContainerRoot(container, workspaceCwd!)
            : undefined;
        const networkPolicyPlaceholderMarker =
            containerNetworkBridgeRoot === undefined ||
            !protectsProjectMetadata ||
            networkPolicyFiles.length === 0
                ? undefined
                : posix.join(
                      containerNetworkBridgeRoot,
                      `.policy-${contextId}-${String(sessionId)}`,
                  );
        let networkPolicyState:
            | Awaited<ReturnType<typeof loadDockerProjectManagedNetworkPolicyState>>
            | undefined;
        try {
            networkPolicyState =
                networkPolicyPlaceholderMarker === undefined
                    ? undefined
                    : await loadDockerProjectManagedNetworkPolicyState(
                          container,
                          cwd,
                          containerNetworkBridgeRoot!,
                          networkPolicyPlaceholderMarker,
                          networkPolicyFiles,
                          options.parseNetworkConfig,
                      );
        } catch (error) {
            if (networkPolicyPlaceholderMarker !== undefined) {
                await cleanupDockerNetworkPolicyPlaceholder(
                    container,
                    cwd,
                    containerNetworkBridgeRoot!,
                    networkPolicyPlaceholderMarker,
                    networkPolicyFiles[0]!,
                ).catch(() => undefined);
            }
            throw error;
        }
        const resolvedNetwork = resolveDockerNetworkPermissions(
            permissions,
            networkPolicyState?.policy,
        );
        const networkPolicy = directEgress
            ? undefined
            : (resolvedNetwork.managedPolicy ?? requestedNetworkPolicy);
        const networkPolicyPlaceholderCleanup =
            networkPolicyState?.placeholderNetworkPolicyFile !== undefined &&
            networkPolicyPlaceholderMarker !== undefined &&
            containerNetworkBridgeRoot !== undefined
                ? () =>
                      cleanupDockerNetworkPolicyPlaceholder(
                          container,
                          cwd,
                          containerNetworkBridgeRoot,
                          networkPolicyPlaceholderMarker,
                          networkPolicyState.placeholderNetworkPolicyFile!,
                      )
                : undefined;
        const requiresManagedNetwork =
            networkPolicy !== undefined &&
            ((networkPolicy.allowedDomains?.length ?? 0) > 0 ||
                (networkPolicy.allowedLoopbackPorts?.length ?? 0) > 0);
        let managedNetwork: DockerManagedNetwork | undefined;
        try {
            const networkBridgeHostPath =
                requiresManagedNetwork && containerNetworkBridgeRoot !== undefined
                    ? await loadNetworkBridgeHostPath(
                          container,
                          workspaceCwd!,
                          containerNetworkBridgeRoot,
                      )
                    : undefined;
            managedNetwork = !requiresManagedNetwork
                ? undefined
                : await startDockerManagedNetwork(
                      containerNetworkBridgeRoot!,
                      networkBridgeHostPath!,
                      networkPolicy!,
                      options.networkInterceptor,
                  );
            if (containerNetworkBridgeRoot !== undefined) {
                await validateDockerNetworkBridgeRoot(container, containerNetworkBridgeRoot);
            }
        } catch (error) {
            const failedManagedNetwork = managedNetwork;
            await runCleanupSteps("Docker command startup", [
                ...(failedManagedNetwork === undefined ? [] : [() => failedManagedNetwork.close()]),
                ...(networkPolicyPlaceholderCleanup === undefined
                    ? []
                    : [networkPolicyPlaceholderCleanup]),
            ]);
            throw error;
        }
        let invokedCommand: string[];
        try {
            invokedCommand = !needsSandbox
                ? [shell, "-lc", runOptions.command]
                : createDockerSandboxCommand({
                      command: runOptions.command,
                      commandCwd: runCwd,
                      deniedReadPaths: await resolveDockerDeniedReadPaths(environment, [
                          ...(permissions.deniedReadPaths ?? []),
                          ...hostPrivateDirectories,
                      ]),
                      isolateNetwork: !directEgress,
                      mode: permissionMode,
                      protectedPaths: await resolveDockerPermissionPaths(environment, [
                          ...(permissions.deniedWritePaths ?? []),
                          ...hostDeniedWritePaths,
                      ]),
                      protectedProjectFiles:
                          permissionMode === "full_access" ? [] : protectedProjectFiles,
                      readablePaths:
                          permissionMode === "full_access"
                              ? []
                              : await resolveExistingDockerPermissionPaths(
                                    environment,
                                    readableDirectories,
                                ),
                      writablePaths:
                          permissionMode === "read_only"
                              ? []
                              : await resolveExistingDockerPermissionPaths(
                                    environment,
                                    permissions.allowedWritePaths ?? [],
                                ),
                      ...(containerNetworkBridgeRoot === undefined
                          ? {}
                          : { networkBridgeRoot: containerNetworkBridgeRoot }),
                      ...(managedNetwork === undefined
                          ? {}
                          : {
                                networkUnixProxySockets: {
                                    authenticationToken: managedNetwork.authenticationToken,
                                    http: managedNetwork.containerHttpSocketPath,
                                    loopback: managedNetwork.containerLoopbackSockets,
                                    socks: managedNetwork.containerSocksSocketPath,
                                },
                            }),
                      ...(networkPolicyState === undefined
                          ? {}
                          : {
                                readyNetworkPolicyFiles: networkPolicyState.readyNetworkPolicyFiles,
                            }),
                      runtime: runtime!,
                      shell,
                      workspaceCwd: workspaceCwd ?? cwd,
                  });
        } catch (error) {
            await runCleanupSteps("Docker command startup", [
                ...(managedNetwork === undefined ? [] : [() => managedNetwork.close()]),
                ...(networkPolicyPlaceholderCleanup === undefined
                    ? []
                    : [networkPolicyPlaceholderCleanup]),
            ]);
            throw error;
        }
        const protectedCreatePaths =
            workspaceCwd === undefined || permissionMode === "read_only"
                ? []
                : [
                      ...(permissionMode === "full_access"
                          ? []
                          : [".git", ...protectedProjectFiles].map((name) =>
                                posix.join(workspaceCwd, name),
                            )),
                      ...(await findAbsentDeniedWritePaths(container, cwd, [
                          ...(permissions.deniedWritePaths ?? []),
                          ...hostDeniedWritePaths,
                      ])),
                  ];
        let exec: Dockerode.Exec;
        try {
            const payloadCommand =
                protectedCreatePaths.length === 0
                    ? invokedCommand
                    : [
                          "/bin/sh",
                          "-c",
                          DOCKER_PROTECTED_PATH_MONITOR_SCRIPT,
                          "compute-protected-paths",
                          pidFile,
                          ...protectedCreatePaths,
                          "--",
                          ...invokedCommand,
                      ];
            const commandEnvironment = withDockerManagedNetworkEnvironment(
                baseEnvironment,
                managedNetwork,
                managedNetwork !== undefined,
            );
            exec = await container.exec({
                AttachStdin: true,
                AttachStderr: true,
                AttachStdout: true,
                Cmd: [
                    "/bin/sh",
                    "-c",
                    DOCKER_EXEC_START_GATE_SCRIPT,
                    "compute-command",
                    pidFile,
                    ...payloadCommand,
                ],
                ...(Object.keys(commandEnvironment).length === 0
                    ? {}
                    : {
                          Env: Object.entries(commandEnvironment).map(
                              ([name, value]) => `${name}=${value ?? ""}`,
                          ),
                      }),
                Tty: false,
                WorkingDir: runCwd,
            });
        } catch (error) {
            await runCleanupSteps("Docker command startup", [
                ...(managedNetwork === undefined ? [] : [() => managedNetwork.close()]),
                ...(networkPolicyPlaceholderCleanup === undefined
                    ? []
                    : [networkPolicyPlaceholderCleanup]),
            ]);
            throw error;
        }
        let stream!: Duplex;
        try {
            stream = await exec.start({ hijack: true, stdin: true, Tty: false });
            stream.write(DOCKER_EXEC_START_GATE);
        } catch (error) {
            stream?.end();
            await runCleanupSteps("Docker command startup", [
                ...(managedNetwork === undefined ? [] : [() => managedNetwork.close()]),
                ...(networkPolicyPlaceholderCleanup === undefined
                    ? []
                    : [networkPolicyPlaceholderCleanup]),
            ]);
            throw error;
        }
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        const maximum = runOptions.maxOutputBytes ?? 512_000;
        const session: DockerShellSession = {
            command: runOptions.command,
            completion: Promise.resolve(),
            consumingWaiters: 0,
            cwd: runCwd,
            exec,
            exitCode: null,
            exitObserved,
            finished: false,
            killed: false,
            ...(managedNetwork === undefined ? {} : { managedNetwork }),
            ...(networkPolicyPlaceholderCleanup === undefined
                ? {}
                : { networkPolicyPlaceholderCleanup }),
            pidFile,
            sessionId,
            stderr: new BoundedOutputBuffer(maximum),
            stderrUnread: new BoundedOutputBuffer(maximum),
            stderrOffset: 0,
            stdout: new BoundedOutputBuffer(maximum),
            stdoutUnread: new BoundedOutputBuffer(maximum),
            stdoutOffset: 0,
            stream,
            timedOut: false,
        };
        const appendStderr = (chunk: Buffer): void => {
            session.stderr.append(chunk);
            session.stderrUnread.append(chunk);
        };
        stdoutStream.on("data", (chunk: Buffer) => {
            session.stdout.append(chunk);
            session.stdoutUnread.append(chunk);
        });
        stderrStream.on("data", (chunk: Buffer) => {
            appendStderr(chunk);
        });
        container.modem.demuxStream(stream, stdoutStream, stderrStream);
        session.completion = new Promise<void>((resolve) => {
            let settled = false;
            const finish = async (error?: Error) => {
                if (settled) return;
                settled = true;
                session.stopNetworkDenialListener?.();
                delete session.stopNetworkDenialListener;
                if (error !== undefined) {
                    appendStderr(Buffer.from(error.message));
                }
                try {
                    session.exitCode = (await inspectDockerExec(exec)).ExitCode;
                } catch (inspectError) {
                    appendStderr(
                        Buffer.from(
                            `Could not inspect the Docker command after it exited: ${errorToMessage(inspectError)}\n`,
                        ),
                    );
                    session.exitCode = null;
                }
                try {
                    await runCleanupSteps("Docker command", [
                        ...(session.managedNetwork === undefined
                            ? []
                            : [() => session.managedNetwork!.close()]),
                        ...(session.networkPolicyPlaceholderCleanup === undefined
                            ? []
                            : [session.networkPolicyPlaceholderCleanup]),
                    ]);
                } catch (cleanupError) {
                    appendStderr(
                        Buffer.from(`Command cleanup failed: ${errorToMessage(cleanupError)}\n`),
                    );
                    session.exitCode = 1;
                }
                if (session.networkDenial !== undefined) {
                    appendStderr(Buffer.from(formatManagedNetworkDenial(session.networkDenial)));
                    session.exitCode = 1;
                    session.killed = false;
                }
                session.finished = true;
                if (session.timeout !== undefined) clearTimeout(session.timeout);
                const awaited = session.consumingWaiters > 0;
                onActiveSessionCountChange?.(activeSessionCount());
                trimFinishedSessions();
                resolve();
                if (!awaited && !session.exitObserved) {
                    await onSessionExit?.({
                        command: session.command,
                        exitCode: session.exitCode,
                        sessionId,
                        status:
                            session.killed || session.exitCode === null ? "killed" : "completed",
                    });
                }
            };
            stream.once("error", (error) => void finish(error));
            stream.once("end", () => void finish());
            stream.once("close", () => void finish());
        });
        sessions.set(sessionId, session);
        const stopNetworkDenialListener = managedNetwork?.proxy.onBlockedRequest((request) => {
            session.networkDenial ??= request;
            requestKill(session);
        });
        if (stopNetworkDenialListener !== undefined) {
            session.stopNetworkDenialListener = stopNetworkDenialListener;
        }
        onActiveSessionCountChange?.(activeSessionCount());
        if (runOptions.timeoutMs !== undefined) {
            session.timeout = setTimeout(
                () => {
                    // Reaching the timeout backgrounds the session; it marks it timed out and never
                    // stops the command, which keeps running for the agent to come back to.
                    session.timedOut = true;
                },
                Math.max(0, runOptions.timeoutMs),
            );
            session.timeout.unref();
        }
        trimFinishedSessions();
        return session;
    };

    const loadSandboxRuntime = async (
        container: Dockerode.Container,
    ): Promise<PreparedDockerSandbox> => {
        if (sandboxRuntime === undefined) {
            const pending = prepareDockerSandbox(container);
            sandboxRuntime = pending;
            void pending.catch(() => {
                if (sandboxRuntime === pending) sandboxRuntime = undefined;
            });
        }
        return sandboxRuntime;
    };

    const loadCanonicalWorkspace = (): Promise<string> => {
        canonicalWorkspace ??= resolveDockerPath(environment, cwd).catch((error: unknown) => {
            canonicalWorkspace = undefined;
            throw error;
        });
        return canonicalWorkspace;
    };

    const loadNetworkBridgeHostPath = async (
        container: Dockerode.Container,
        workspaceCwd: string,
        expectedContainerRoot: string,
    ): Promise<string> => {
        const mapping = await resolveDockerBindMountPath(container, workspaceCwd);
        await prepareDockerNetworkBridgeHostRoot(mapping.hostPath);
        const containerPath = posix.join(mapping.containerPath, DOCKER_NETWORK_BRIDGE_DIRECTORY);
        if (containerPath !== expectedContainerRoot) {
            throw new Error(
                "Docker managed network bridge root does not match the working-directory bind mount.",
            );
        }
        await validateDockerNetworkBridgeRoot(container, containerPath);
        return mapping.hostPath;
    };

    const kill = async (session: DockerShellSession): Promise<void> => {
        if (session.finished) return;
        session.killed = true;
        const container = await environment.container();
        await runDockerExec(container, [
            "/bin/sh",
            "-c",
            'pid=$(cat "$1" 2>/dev/null) || exit 0; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
            "compute-stop",
            session.pidFile,
        ]).catch(() => undefined);
        session.stream.end();
        await Promise.race([
            session.completion,
            new Promise<void>((resolve) => setTimeout(resolve, BASH_SESSION_STOP_GRACE_MS)),
        ]);
        if (!session.finished) {
            await runDockerExec(container, [
                "/bin/sh",
                "-c",
                'pid=$(cat "$1" 2>/dev/null) || exit 0; kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
                "compute-force-stop",
                session.pidFile,
            ]).catch(() => undefined);
            await Promise.race([
                session.completion,
                new Promise<void>((resolve) => setTimeout(resolve, 500)),
            ]);
        }
        if (!session.finished) {
            session.stream.destroy();
            await session.completion;
        }
    };

    const interrupt = async (session: DockerShellSession): Promise<boolean> => {
        if (session.finished) return false;
        const container = await environment.container();
        const result = await runDockerExec(container, [
            "/bin/sh",
            "-c",
            'pid=$(cat "$1" 2>/dev/null) || exit 1; kill -INT -- "-$pid" 2>/dev/null || kill -INT "$pid" 2>/dev/null',
            "compute-interrupt",
            session.pidFile,
        ]);
        return result.exitCode === 0;
    };

    /**
     * Forgets the oldest finished commands once too many have piled up. Runs whenever a command
     * starts or ends, so a session that only ever finishes work still lets go of what it holds.
     */
    const trimFinishedSessions = (): void => {
        while (sessions.size > MAX_RETAINED_SESSIONS) {
            const finished = [...sessions.values()]
                .filter((candidate) => candidate.finished)
                .sort((left, right) => left.sessionId - right.sessionId)[0];
            if (finished === undefined) return;
            sessions.delete(finished.sessionId);
        }
    };

    /**
     * Makes room for one more background command. Running out of slots is our problem, not the
     * agent's, so the oldest command is evicted to free one. The evicted session stays readable: it
     * is stopped, not forgotten, and frees its slot the moment it is asked to stop.
     */
    const makeRoomForSession = (): void => {
        for (;;) {
            const active = [...sessions.values()].filter(
                (session) => !session.finished && !session.evicted,
            );
            if (active.length < MAX_ACTIVE_SESSIONS) return;
            const oldest = active.sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) return;
            oldest.evicted = true;
            requestKill(oldest);
        }
    };

    const requestKill = (session: DockerShellSession): void => {
        void kill(session).catch((error: unknown) => {
            session.stream.destroy(
                error instanceof Error
                    ? error
                    : new Error(`Could not stop Docker command: ${String(error)}`),
            );
        });
    };

    const snapshot = (session: DockerShellSession, peek = false): ComputeSessionSnapshot => {
        const stdoutDeltaBuffer = peek
            ? session.stdoutUnread.clone()
            : session.stdoutUnread.drain();
        const stderrDeltaBuffer = peek
            ? session.stderrUnread.clone()
            : session.stderrUnread.drain();
        const stdoutDelta = stdoutDeltaBuffer.snapshot().toString("utf8");
        const stderrDelta = stderrDeltaBuffer.snapshot().toString("utf8");
        if (!peek) {
            session.stdoutOffset = session.stdout.totalBytes - session.stdoutUnread.totalBytes;
            session.stderrOffset = session.stderr.totalBytes - session.stderrUnread.totalBytes;
            if (session.finished) session.exitObserved = true;
        }
        return {
            command: session.command,
            cwd: session.cwd,
            exitCode: session.exitCode,
            sessionId: session.sessionId,
            status: session.finished
                ? session.killed || session.exitCode === null
                    ? "killed"
                    : "completed"
                : "running",
            stderr: session.stderr.snapshot().toString("utf8"),
            stderrDelta,
            stderrBytes: session.stderr.totalBytes,
            stderrDeltaBytes: stderrDeltaBuffer.totalBytes,
            stderrDeltaOmittedBytes: stderrDeltaBuffer.omittedBytes,
            stderrOmittedBytes: session.stderr.omittedBytes,
            stdout: session.stdout.snapshot().toString("utf8"),
            stdoutDelta,
            stdoutBytes: session.stdout.totalBytes,
            stdoutDeltaBytes: stdoutDeltaBuffer.totalBytes,
            stdoutDeltaOmittedBytes: stdoutDeltaBuffer.omittedBytes,
            stdoutOmittedBytes: session.stdout.omittedBytes,
            timedOut: session.timedOut,
        };
    };

    return {
        activeSessionCount,
        activeSessions: (): readonly ComputeSessionActivity[] =>
            [...sessions.values()]
                .filter((session) => !session.finished)
                .map((session) => ({
                    command: session.command,
                    cwd: session.cwd,
                    sessionId: session.sessionId,
                    status: "running" as const,
                })),
        cwd,
        async interruptSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            return interrupt(session);
        },
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => !session.finished);
            for (const session of active) session.exitObserved = true;
            await Promise.all(active.map(kill));
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            session.exitObserved = true;
            await kill(session);
            // Stopping reports status; it must not swallow unread output.
            return snapshot(session, true);
        },
        async readSession(sessionId, readOptions = {}) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            const waitMs = Math.max(0, readOptions.waitMs ?? 0);
            const peeking = readOptions.peek === true;
            if (!session.finished && waitMs > 0 && !readOptions.signal?.aborted) {
                if (!peeking) session.consumingWaiters += 1;
                try {
                    await new Promise<void>((resolve) => {
                        let settled = false;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(timer);
                            readOptions.signal?.removeEventListener("abort", finish);
                            resolve();
                        };
                        const timer = setTimeout(finish, waitMs);
                        readOptions.signal?.addEventListener("abort", finish, { once: true });
                        void session.completion.then(finish);
                    });
                } finally {
                    if (!peeking) session.consumingWaiters -= 1;
                }
            }
            return snapshot(session, peeking);
        },
        async run(runOptions) {
            const { signal, ...startOptions } = runOptions;
            const session = await start(
                { ...startOptions, timeoutMs: startOptions.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS },
                true,
            );
            const abort = () => requestKill(session);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            try {
                await session.completion;
                const result = snapshot(session);
                return toRunResult(result);
            } finally {
                signal?.removeEventListener("abort", abort);
            }
        },
        setActiveSessionCountListener(listener) {
            onActiveSessionCountChange = listener;
            listener?.(activeSessionCount());
        },
        setSessionExitListener(listener) {
            onSessionExit = listener;
        },
        async startSession(startOptions) {
            makeRoomForSession();
            return (await start(startOptions)).sessionId;
        },
        sessionUsesSecrets() {
            return false;
        },
        supportsSessionInput: true,
        async writeSession(_permissions, sessionId, data) {
            const session = sessions.get(sessionId);
            if (session === undefined || session.finished || session.stream.destroyed) return false;
            return session.stream.write(data);
        },
    };
}

function snapshotPermissions(permissions: ComputePermissions): ComputePermissions {
    return {
        mode: permissions.mode,
        network: {
            egress: permissions.network.egress,
            localBinding: permissions.network.localBinding,
            ...(permissions.network.allowedHosts === undefined
                ? {}
                : { allowedHosts: [...permissions.network.allowedHosts] }),
        },
        ...(permissions.allowedReadPaths === undefined
            ? {}
            : { allowedReadPaths: [...permissions.allowedReadPaths] }),
        ...(permissions.deniedReadPaths === undefined
            ? {}
            : { deniedReadPaths: [...permissions.deniedReadPaths] }),
        ...(permissions.allowedWritePaths === undefined
            ? {}
            : { allowedWritePaths: [...permissions.allowedWritePaths] }),
        ...(permissions.deniedWritePaths === undefined
            ? {}
            : { deniedWritePaths: [...permissions.deniedWritePaths] }),
    };
}

async function resolveDockerPermissionPaths(
    environment: DockerEnvironment,
    paths: readonly string[],
): Promise<readonly string[]> {
    const cwd = environment.config.workingDirectory;
    const resolved = await Promise.all(
        paths.flatMap((path) => {
            const target = posix.resolve(cwd, path);
            return [target, resolveDockerPath(environment, target)];
        }),
    );
    return [...new Set(resolved)];
}

async function resolveExistingDockerPermissionPaths(
    environment: DockerEnvironment,
    paths: readonly string[],
): Promise<readonly string[]> {
    const resolved = await resolveDockerPermissionPaths(environment, paths);
    if (resolved.length === 0) return [];
    const result = await runDockerExec(
        await environment.container(),
        [
            "/bin/sh",
            "-c",
            'for path do if [ -e "$path" ] || [ -L "$path" ]; then printf "1\\n"; else printf "0\\n"; fi; done',
            "compute-permission-paths",
            ...resolved,
        ],
        { maxOutputBytes: resolved.length * 2 },
    );
    if (result.exitCode !== 0) {
        throw new Error("Could not inspect Docker permission paths.");
    }
    const exists = result.stdout.toString("utf8").trimEnd().split("\n");
    if (exists.length !== resolved.length) {
        throw new Error("Docker returned incomplete permission-path metadata.");
    }
    return resolved.filter((_path, index) => exists[index] === "1");
}

async function resolveDockerDeniedReadPaths(
    environment: DockerEnvironment,
    paths: readonly string[],
): Promise<readonly { kind: "directory" | "file"; path: string }[]> {
    const resolved = await resolveExistingDockerPermissionPaths(environment, paths);
    if (resolved.length === 0) return [];
    const result = await runDockerExec(
        await environment.container(),
        [
            "/bin/sh",
            "-c",
            'for path do if [ -d "$path" ] && [ ! -L "$path" ]; then printf "directory\\n"; else printf "file\\n"; fi; done',
            "compute-denied-read-paths",
            ...resolved,
        ],
        { maxOutputBytes: resolved.length * 10 },
    );
    if (result.exitCode !== 0) {
        throw new Error("Could not inspect denied Docker read paths.");
    }
    const kinds = result.stdout.toString("utf8").trimEnd().split("\n");
    if (kinds.length !== resolved.length) {
        throw new Error("Docker returned incomplete denied-read metadata.");
    }
    return resolved.map((path, index) => ({
        kind: kinds[index] === "directory" ? "directory" : "file",
        path,
    }));
}

async function findAbsentDeniedWritePaths(
    container: Dockerode.Container,
    cwd: string,
    paths: readonly string[],
): Promise<readonly string[]> {
    const targets = [...new Set(paths.map((path) => posix.resolve(cwd, path)))];
    if (targets.length === 0) return [];
    const result = await runDockerExec(
        container,
        [
            "/bin/sh",
            "-c",
            'for path do if [ -e "$path" ] || [ -L "$path" ]; then printf "0\\n"; else printf "1\\n"; fi; done',
            "compute-denied-write-paths",
            ...targets,
        ],
        { maxOutputBytes: targets.length * 2 },
    );
    if (result.exitCode !== 0) {
        throw new Error("Could not inspect denied Docker write paths.");
    }
    const absent = result.stdout.toString("utf8").trimEnd().split("\n");
    if (absent.length !== targets.length) {
        throw new Error("Docker returned incomplete denied-write metadata.");
    }
    return targets.filter((_path, index) => absent[index] === "1");
}

function toRunResult(result: ComputeSessionSnapshot): ComputeRunResult {
    return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        ...(result.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
        ...(result.stderrOmittedBytes === undefined
            ? {}
            : { stderrOmittedBytes: result.stderrOmittedBytes }),
        stdout: result.stdout,
        ...(result.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
        ...(result.stdoutOmittedBytes === undefined
            ? {}
            : { stdoutOmittedBytes: result.stdoutOmittedBytes }),
        timedOut: result.timedOut,
    };
}

function assertNoSecrets(secrets: readonly string[] | undefined): void {
    if (secrets !== undefined && secrets.length > 0) {
        throw new Error("The Docker backend cannot inject secret bundles.");
    }
}

async function inspectDockerExec(exec: Dockerode.Exec): Promise<Dockerode.ExecInspectInfo> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            exec.inspect(),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("Timed out waiting for Docker command status.")),
                    DOCKER_EXEC_INSPECT_TIMEOUT_MS,
                );
                timeout.unref();
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

async function startDockerManagedNetwork(
    containerBridgeRoot: string,
    workspaceHostPath: string,
    policy: ManagedNetworkPolicy,
    networkInterceptor?: ManagedNetworkInterceptor,
): Promise<DockerManagedNetwork> {
    if (
        (policy.allowedDomains?.length ?? 0) === 0 &&
        (policy.allowedLoopbackPorts?.length ?? 0) === 0
    ) {
        throw new Error(
            "Managed network access requires an allowed domain or an allowed loopback port.",
        );
    }
    validateManagedNetworkLoopbackPorts(policy.allowedLoopbackPorts ?? []);
    const hostBridgeRoot = await prepareDockerNetworkBridgeHostRoot(workspaceHostPath);
    const directory = await mkdtemp(join(hostBridgeRoot, "command-"));
    const containerDirectory = posix.join(containerBridgeRoot, basename(directory));
    let shortRoot: string | undefined;
    let proxy: ManagedNetworkProxyHandle | undefined;
    let bridge: LinuxManagedNetworkBridge | undefined;
    try {
        shortRoot = await mkdtemp("/tmp/compute-network-");
        const runningShortRoot = shortRoot;
        const shortDirectory = join(runningShortRoot, "s");
        await symlink(directory, shortDirectory, "dir");
        const runningProxy = await startManagedNetworkProxy(
            policy,
            networkInterceptor === undefined ? {} : { networkInterceptor },
        );
        proxy = runningProxy;
        bridge = await startLinuxManagedNetworkBridge(runningProxy, {
            directory: shortDirectory,
            ...(policy.allowedLoopbackPorts === undefined
                ? {}
                : { loopbackPorts: policy.allowedLoopbackPorts }),
        });
        await makeDockerBridgeDirectoryTraversable(directory);
        const runningBridge = bridge;
        let closed = false;
        return {
            authenticationToken: runningBridge.authenticationToken,
            bridge: runningBridge,
            containerHttpSocketPath: posix.join(containerDirectory, "http.sock"),
            containerLoopbackSockets: runningBridge.loopbackSockets.map(({ port }) => ({
                path: posix.join(containerDirectory, `loopback-${String(port)}.sock`),
                port,
            })),
            containerSocksSocketPath: posix.join(containerDirectory, "socks.sock"),
            proxy: runningProxy,
            async close() {
                if (closed) return;
                await runCleanupSteps("Docker managed network", [
                    () => runningBridge.close(),
                    () => runningProxy.close(),
                    () => rm(runningShortRoot, { force: true, recursive: true }),
                    () => rm(directory, { force: true, recursive: true }),
                ]);
                closed = true;
            },
        };
    } catch (error) {
        const failedProxy = proxy;
        const failedBridge = bridge;
        await runCleanupSteps("Docker managed network startup", [
            ...(failedBridge === undefined ? [] : [() => failedBridge.close()]),
            ...(failedProxy === undefined ? [] : [() => failedProxy.close()]),
            ...(shortRoot === undefined
                ? []
                : [() => rm(shortRoot!, { force: true, recursive: true })]),
            () => rm(directory, { force: true, recursive: true }),
        ]);
        throw error;
    }
}

async function validateDockerNetworkBridgeRoot(
    container: Dockerode.Container,
    root: string,
): Promise<void> {
    const result = await runDockerExec(container, [
        "/bin/sh",
        "-c",
        '[ -d "$1" ] && [ ! -L "$1" ]',
        "compute-network-validation",
        root,
    ]);
    if (result.exitCode !== 0) {
        throw new Error(
            "Could not validate the protected Docker network bridge directory immediately before command startup.",
        );
    }
}

async function makeDockerBridgeDirectoryTraversable(directory: string): Promise<void> {
    // The random command token remains the authorization boundary. Traverse-only directory
    // access lets a container UID that differs from the host UID reach the authenticated
    // bridge without allowing it to list or replace any bridge path.
    await chmod(directory, 0o711);
}

function withDockerManagedNetworkEnvironment(
    environment: Readonly<Record<string, string>>,
    managedNetwork: DockerManagedNetwork | undefined,
    useProxyEnvironment: boolean,
): Record<string, string> {
    if (managedNetwork === undefined || !useProxyEnvironment) return { ...environment };
    const noProxy = "localhost,127.0.0.1,::1";
    return {
        ...environment,
        ALL_PROXY: "socks5h://127.0.0.1:1080",
        HTTP_PROXY: "http://127.0.0.1:3128",
        HTTPS_PROXY: "http://127.0.0.1:3128",
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: noProxy,
        all_proxy: "socks5h://127.0.0.1:1080",
        http_proxy: "http://127.0.0.1:3128",
        https_proxy: "http://127.0.0.1:3128",
        no_proxy: noProxy,
    };
}
