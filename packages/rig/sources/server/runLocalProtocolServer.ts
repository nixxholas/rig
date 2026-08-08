import { chmod, open } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { createProtocolHttpServer } from "./createProtocolHttpServer.js";
import { DaemonLog } from "./DaemonLog.js";
import { recordProviderFailure } from "./recordProviderFailure.js";
import { configureSessionRequest } from "../session/configureSessionRequest.js";
import {
    createDaemonStartupRequestListener,
    type DaemonStartupState,
} from "./createDaemonStartupRequestListener.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import { GitStateTracker } from "../git/GitStateTracker.js";
import { getEnvironmentLocalServerPaths } from "./getEnvironmentLocalServerPaths.js";
import { installDaemonProcessFailureLogging } from "./installDaemonProcessFailureLogging.js";
import { loadHappyIntegration, type HappyIntegrationMode } from "./loadHappyIntegration.js";
import { markGitStateFromSessionEvent } from "../git/markGitStateFromSessionEvent.js";
import { publishGitLiveEvent } from "../git/publishGitLiveEvent.js";
import { prepareLocalServerDirectory } from "./prepareLocalServerDirectory.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { TrackedTaskDrain } from "../utils/TrackedTaskDrain.js";
import { readLocalServerToken } from "./readLocalServerToken.js";
import { removeStaleSocket } from "./removeStaleSocket.js";
import { resolveHappyIntegrationMode } from "./resolveHappyIntegrationMode.js";
import { CompositeMcpToolProvider, McpClientManager, type McpToolProvider } from "../mcp/index.js";
import {
    ensureUserConfigurationFiles,
    loadConfig,
    resolveProtectedPaths,
    writeDaemonSettings,
    writeP2pNodeSettings,
} from "../config/index.js";
import { createConfiguredPresenceStore } from "../presence/index.js";
import { createProviderQuotaService } from "../executor/createProviderQuotaService.js";
import {
    createProviderUsageTracker,
    type ProviderUsageTracker,
} from "../executor/createProviderUsageTracker.js";
import { createProviderUsageService } from "../executor/createProviderUsageService.js";
import { createCredentialBindingUsageRouter } from "../executor/createCredentialBindingUsageRouter.js";
import { loadConfiguredProviderUsage } from "../executor/loadConfiguredProviderUsage.js";
import { gracefulShutdown } from "../concurrency/index.js";
import { disableUnavailableProviders } from "../executor/disableUnavailableProviders.js";
import { resolveProviderDisabledReasons } from "../executor/resolveProviderDisabledReasons.js";
import { createCodingAssistantAgent } from "../runtime/createCodingAssistantAgent.js";
import { getDaemonIdentity } from "../daemon/index.js";
import { errorToMessage } from "../errorToMessage.js";
import {
    acquireSqliteProcessLock,
    SqliteProcessLockUnavailableError,
    type SqliteProcessLock,
} from "../persistence/database/acquireSqliteProcessLock.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { getNodeInspectorUrl, openNodeInspector, registerRigDebugRoot } from "../debug/index.js";
import { RigUserError } from "../RigUserError.js";
import type { HappySyncService } from "../happy/index.js";
import { getManagedWorkspacesDirectory } from "../project/getManagedWorkspacesDirectory.js";
import type { LocalServerPaths } from "./LocalServerPaths.js";
import { writeDaemonCrashReport } from "./writeDaemonCrashReport.js";
import type { PluginContext } from "../agent/context/PluginContext.js";
import type { WorkletContext } from "../agent/context/WorkletContext.js";
import { PluginManager, PluginMcpRegistry } from "../plugins/index.js";
import { WorkletManager, WorkletToolRegistry } from "../worklets/index.js";
import { createGeneratedMediaStore, getGeneratedDirectory } from "../generated-media/index.js";
import { createEventIdFactory, type GlobalLiveEvent, type P2pStatus } from "../protocol/index.js";
import {
    loadOrCreateIrohSecretKey,
    loadOrCreateP2pIdentity,
    P2pNetwork,
    P2pPairingService,
    P2pPeerTrustStore,
    recoverP2pPairings,
} from "../p2p/index.js";
import { createServeP2pHttpRequest } from "./createServeP2pHttpRequest.js";
import { createServeP2pTunnel } from "./createServeP2pTunnel.js";
import {
    P2pProfileReplicator,
    replicateProfileForP2pRequest,
    RigProfileStore,
} from "../profiles/index.js";
import { GitHubSecretSync } from "../secrets/index.js";
import {
    createLocalCredentialSnapshot,
    P2pCredentialReplicator,
    P2pCredentialRuntimeRegistry,
    P2pCredentialStore,
} from "../credentials/index.js";

export interface RunLocalProtocolServerOptions {
    happyIntegration?: HappyIntegrationMode;
    socketPath?: string;
    tokenPath?: string;
}

export async function runLocalProtocolServer(
    options: RunLocalProtocolServerOptions = {},
): Promise<void> {
    const paths = getEnvironmentLocalServerPaths();
    let databaseLock: SqliteProcessLock;
    try {
        databaseLock = await acquireSqliteProcessLock(`${paths.databasePath}.lock`);
    } catch (error) {
        if (error instanceof SqliteProcessLockUnavailableError) {
            throw new RigUserError("Another Rig daemon already owns the session database.", {
                hint: "Connect to the running daemon or stop it before starting another.",
            });
        }
        throw error;
    }
    try {
        await runOwnedLocalProtocolServer(options, paths);
    } finally {
        databaseLock.release();
    }
}

async function runOwnedLocalProtocolServer(
    options: RunLocalProtocolServerOptions,
    paths: LocalServerPaths,
): Promise<void> {
    await prepareLocalServerDirectory(paths.directory);
    const socketPath = options.socketPath ?? paths.socketPath;
    const tokenPath = options.tokenPath ?? paths.tokenPath;
    const startedAt = new Date().toISOString();
    const identity = getDaemonIdentity();
    const daemonLog = new DaemonLog({ path: paths.logPath, version: identity.version });
    daemonLog.record("info", "daemon_starting", "Rig daemon is starting.", {
        databasePath: paths.databasePath,
        ...(identity.developmentBuildId === undefined
            ? {}
            : { developmentBuildId: identity.developmentBuildId }),
        socketPath,
    });
    const uninstallProcessFailureLogging = installDaemonProcessFailureLogging(
        daemonLog,
        process,
        writeDaemonCrashReport,
    );
    let token: string;
    try {
        token = await readLocalServerToken(tokenPath);
        await removeStaleSocket(socketPath);
    } catch (error) {
        daemonLog.record("error", "daemon_startup_failed", "Rig daemon could not start.", {
            error: errorToMessage(error),
        });
        uninstallProcessFailureLogging();
        throw error;
    }

    let startupState: DaemonStartupState = { status: "starting" };
    let mcpToolProvider: McpToolProvider | undefined;
    let worklets: WorkletManager | undefined;
    let p2pNetwork: P2pNetwork | undefined;
    let p2pPairingService: P2pPairingService | undefined;
    let p2pProfileReplicator: P2pProfileReplicator | undefined;
    let p2pCredentialReplicator: P2pCredentialReplicator | undefined;
    let p2pCredentialRuntimeRegistry: P2pCredentialRuntimeRegistry | undefined;
    let p2pCredentialStore: P2pCredentialStore | undefined;
    let rigProfiles: RigProfileStore | undefined;
    let happySyncService: HappySyncService | undefined;
    let happyLifecycle = Promise.resolve();
    let gitStateTracker: GitStateTracker | undefined;
    let store: PersistentSessionStore | undefined;
    let taskDrain: TrackedTaskDrain | undefined;
    let providerUsageTracker: ProviderUsageTracker | undefined;
    let stopping = false;
    const shutdown = gracefulShutdown();
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    const runHappyLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = happyLifecycle.then(operation, operation);
        happyLifecycle = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    };
    const stopServer = (reason = "Shutdown requested.") => {
        if (stopping) return;
        stopping = true;
        daemonLog.record("info", "daemon_stopping", "Rig daemon is stopping.", { reason });
        // Disposal comes before the drain closes: it aborts in-flight Git scans, so draining waits
        // on work that has already been told to stop rather than on a full scan timeout.
        gitStateTracker?.dispose();
        taskDrain?.beginClose();
        void (async () => {
            // Background loops are told to stop first, and the names of any
            // that linger say what the daemon is waiting for.
            const report = await shutdown.shutdown();
            if (report.timedOut.length > 0) {
                daemonLog.record(
                    "warning",
                    "daemon_shutdown_slow",
                    "Rig daemon is still waiting for background work to stop.",
                    { pending: report.timedOut.join(", ") },
                );
            }
            for (const failure of report.failed) {
                daemonLog.record(
                    "error",
                    "daemon_shutdown_handler_failed",
                    "A Rig daemon background task failed while shutting down.",
                    { error: errorToMessage(failure.error), task: failure.name },
                );
            }
            if (store !== undefined) {
                try {
                    await store.prepareForShutdown("shutdown");
                } catch (error) {
                    if (isDatabaseFailure(error)) fatalDatabaseFailure ??= error;
                    daemonLog.record(
                        "error",
                        "daemon_shutdown_drain_failed",
                        "Rig daemon could not finish draining interrupted sessions.",
                        { error: errorToMessage(error) },
                    );
                }
            }
            const serverClosed = new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
            server.closeAllConnections();
            await serverClosed;
            resolveStopped?.();
        })();
    };
    const startupRequestListener = createDaemonStartupRequestListener({
        getState: () => startupState,
        identity,
        onShutdown: () => stopServer("Shutdown requested through the daemon protocol."),
        token,
    });
    const server = createServer(startupRequestListener);
    const writeServerRegistry = () => {
        const inspectorUrl = getNodeInspectorUrl();
        return writeRegistry(paths.registryPath, {
            ...(inspectorUrl === undefined ? {} : { inspectorUrl }),
            pid: process.pid,
            socketPath,
            startedAt,
        });
    };
    let initialization = Promise.resolve();
    let fatalDatabaseFailure: unknown;
    const reportStartupError = (error: unknown) => {
        if (stopping) return;
        const message = errorToMessage(error);
        startupState = { error: message, status: "error" };
        daemonLog.record("error", "daemon_startup_failed", "Rig daemon could not start.", {
            error: message,
        });
    };
    const reportInitializationFailure = (error: unknown) => {
        if (isDatabaseFailure(error)) {
            fatalDatabaseFailure ??= error;
            daemonLog.record("error", "daemon_startup_failed", "Rig daemon could not start.", {
                error: errorToMessage(error),
            });
            stopServer("Database failure during daemon initialization.");
            return;
        }
        reportStartupError(error);
    };
    const stopForSigint = () => stopServer("Received SIGINT.");
    const stopForSigterm = () => stopServer("Received SIGTERM.");
    try {
        const previousUmask = process.umask(0o077);
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, () => {
                    server.off("error", reject);
                    resolve();
                });
            });
        } finally {
            process.umask(previousUmask);
        }
        process.once("SIGINT", stopForSigint);
        process.once("SIGTERM", stopForSigterm);
        try {
            await chmod(socketPath, 0o600);
            if (stopping) {
                await stopped;
                return;
            }
            await writeServerRegistry();
        } catch (error) {
            reportStartupError(error);
            await stopped;
            return;
        }
        if (stopping) {
            await stopped;
            return;
        }

        initialization = initializeDaemon().catch(reportInitializationFailure);

        await stopped;
        await initialization;
    } finally {
        process.off("SIGINT", stopForSigint);
        process.off("SIGTERM", stopForSigterm);
        await initialization;
        // Idempotent: a daemon that failed before stopServer ran still releases its watches here.
        gitStateTracker?.dispose();
        if (mcpToolProvider !== undefined) {
            try {
                await mcpToolProvider.close();
            } catch (error) {
                if (isDatabaseFailure(error)) fatalDatabaseFailure ??= error;
                daemonLog.record(
                    "error",
                    "daemon_mcp_shutdown_failed",
                    "Rig daemon could not close every MCP connection.",
                    { error: errorToMessage(error) },
                );
            }
        }
        try {
            await runHappyLifecycle(async () => {
                const service = happySyncService;
                happySyncService = undefined;
                await service?.close();
            });
        } catch (error) {
            daemonLog.record(
                "error",
                "daemon_happy_shutdown_failed",
                "Rig daemon could not close Happy sync.",
                { error: errorToMessage(error) },
            );
            if (isDatabaseFailure(error)) fatalDatabaseFailure ??= error;
        }
        try {
            store?.close();
        } finally {
            daemonLog.record("info", "daemon_stopped", "Rig daemon stopped.");
            uninstallProcessFailureLogging();
        }
    }
    if (fatalDatabaseFailure !== undefined) throw fatalDatabaseFailure;

    async function initializeDaemon(): Promise<void> {
        try {
            await ensureUserConfigurationFiles();
        } catch (error) {
            daemonLog.record(
                "warning",
                "daemon_user_configuration_initialization_failed",
                "Rig could not create the default user configuration files.",
                { error: errorToMessage(error) },
            );
        }
        const loadedConfig = await loadConfig({ cwd: process.cwd() });
        // Session inference ownership is keyed by the same durable identity used to authenticate
        // P2P transport. Starting without it would make credential ownership unstable across
        // restarts, so identity initialization is now part of the daemon's core startup.
        const p2pIdentity = await loadOrCreateP2pIdentity(paths.p2pIdentityPath);
        const machineProtectedPaths = [
            ...new Set([
                ...(loadedConfig.sources.global.values.permissions?.protectedPaths ?? []),
                ...(loadedConfig.sources.runtime.values.permissions?.protectedPaths ?? []),
                ...(loadedConfig.sources.global.values.workspace?.protectedSync ?? []),
                ...(loadedConfig.sources.runtime.values.workspace?.protectedSync ?? []),
            ]),
        ];
        if (stopping) return;
        const runtimeSettings = {
            inferenceMaxRetries: loadedConfig.config.settings.inferenceMaxRetries,
        };

        const providerUsageService = createProviderUsageService({
            loadUsage: (providerId) =>
                loadConfiguredProviderUsage({
                    providerId,
                    providers: loadedConfig.config.providers,
                }),
            onError: (providerId, error) => {
                daemonLog.record(
                    "warning",
                    "provider_usage_poll_failed",
                    "Rig could not read a provider's usage.",
                    { error: errorToMessage(error), providerId },
                );
            },
        });
        const providerQuotaService = createProviderQuotaService({
            loadClaudeUsage: (providerId) => providerUsageService.get(providerId),
            providers: loadedConfig.config.providers,
        });
        providerUsageTracker = createProviderUsageTracker({
            loadUsage: (providerId) => providerUsageService.get(providerId),
            providerIds: Object.keys(loadedConfig.config.providers),
            shutdown,
        });
        providerUsageTracker.start();
        const disabledProviderReasons = await resolveProviderDisabledReasons(
            loadedConfig.config.providers,
            process.env,
        );
        if (stopping) return;
        const availableProviders = disableUnavailableProviders(
            loadedConfig.config.providers,
            disabledProviderReasons,
        );
        const modelCatalog = createModelCatalog({
            cwd: process.cwd(),
            disabledProviderReasons,
            providers: loadedConfig.config.providers,
        });
        const credentialUsageRouter = createCredentialBindingUsageRouter({
            localInstanceId: p2pIdentity.instanceId,
            localProviders: availableProviders,
            localQuotaService: providerQuotaService,
            localUsageService: providerUsageService,
            observeLocalUsage: (usage) => providerUsageTracker?.observe(usage),
            resolveScope: (ownerInstanceId) => p2pCredentialRuntimeRegistry?.scope(ownerInstanceId),
        });
        const pluginMcpRegistry = new PluginMcpRegistry();
        const workletToolRegistry = new WorkletToolRegistry();
        mcpToolProvider = new CompositeMcpToolProvider([
            new McpClientManager(),
            pluginMcpRegistry,
            workletToolRegistry,
        ]);
        taskDrain = new TrackedTaskDrain();
        gitStateTracker = new GitStateTracker({
            // Snapshots ride the live channel, so they reach subscribers without ever entering the
            // durable log; branch and HEAD changes travel as ordinary project/workspace updates.
            // No store means nobody received it, which is a delivery failure rather than a
            // silent success.
            onLiveEvent: (event) =>
                store === undefined ? false : publishGitLiveEvent(store, event),
            onObserverError: (error, entity) => {
                daemonLog.record(
                    "error",
                    "git_state_observer_failed",
                    "Rig could not record or publish a Git state update.",
                    {
                        error: errorToMessage(error),
                        projectId: entity.projectId,
                        ...(entity.workspaceId === undefined
                            ? {}
                            : { workspaceId: entity.workspaceId }),
                    },
                );
            },
            onSnapshot: (entity, snapshot) => {
                const target = {
                    projectId: entity.projectId,
                    ...(entity.workspaceId === undefined
                        ? {}
                        : { workspaceId: entity.workspaceId }),
                };
                // Sessions carry Git state on their own stream, so a client
                // watching a conversation never has to open the project stream
                // as well to see which files changed.
                store?.applyGitSnapshot(target, snapshot);
                if (snapshot.comparison !== "ready") return;
                store?.applyGitFacts(target, snapshot.facts);
            },
            taskDrain,
        });
        const happyModule = await loadHappyIntegration(
            resolveHappyIntegrationMode(
                options.happyIntegration,
                loadedConfig.config.settings.happyIntegration,
            ),
        );
        const happyConfiguration = await happyModule?.importHappyCredentials({
            machineScope: socketPath,
        });
        // Sessions are created before the plugin manager exists, so they reach it through a stable
        // handle rather than a captured instance.
        let pluginManager: PluginManager | undefined;
        const plugins: PluginContext = {
            applySystemPrompt: (input) =>
                requirePluginManager(pluginManager).applySystemPrompt(input),
            callAppTool: (...parameters) =>
                requirePluginManager(pluginManager).callAppTool(...parameters),
            discoverRepository: (...parameters) =>
                requirePluginManager(pluginManager).discoverRepository(...parameters),
            install: (request) => requirePluginManager(pluginManager).install(request),
            installFromGitHub: (...parameters) =>
                requirePluginManager(pluginManager).installFromGitHub(...parameters),
            loadSkills: (fs) => requirePluginManager(pluginManager).loadSkills(fs),
            loadSystemPrompt: () => requirePluginManager(pluginManager).loadSystemPrompt(),
            list: () => requirePluginManager(pluginManager).list(),
            readIcon: (...parameters) =>
                requirePluginManager(pluginManager).readIcon(...parameters),
            network: {
                interceptHttp: (request) =>
                    requirePluginManager(pluginManager).interceptHttp(request),
                observeTunnel: (tunnel) =>
                    requirePluginManager(pluginManager).observeTunnel(tunnel),
                recordFailure: (hostname, error) =>
                    requirePluginManager(pluginManager).recordFailure(hostname, error),
                shouldIntercept: (hostname) =>
                    requirePluginManager(pluginManager).shouldIntercept(hostname),
            },
            readAppResource: (...parameters) =>
                requirePluginManager(pluginManager).readAppResource(...parameters),
            readLog: (name) => requirePluginManager(pluginManager).readLog(name),
            storageDelete: (...parameters) =>
                requirePluginManager(pluginManager).storageDelete(...parameters),
            storageGet: (...parameters) =>
                requirePluginManager(pluginManager).storageGet(...parameters),
            storageList: (...parameters) =>
                requirePluginManager(pluginManager).storageList(...parameters),
            storageSet: (...parameters) =>
                requirePluginManager(pluginManager).storageSet(...parameters),
            trace: (event) => requirePluginManager(pluginManager).trace(event),
            uninstall: (request) => requirePluginManager(pluginManager).uninstall(request),
        };
        // Worklets are reached the same way, except every session gets its own context with its id
        // baked in, so a tool can never claim another agent's authorship through its arguments.
        const workletsFor = (authorSessionId: string): WorkletContext => ({
            install: (request, sourceFileSystem, expectedPermissions) =>
                requireWorkletManager(worklets).install(
                    { ...request, authorSessionId },
                    sourceFileSystem,
                    expectedPermissions === undefined ? {} : { permissions: expectedPermissions },
                ),
            list: () => requireWorkletManager(worklets).list(),
            readLog: (name) => requireWorkletManager(worklets).readLog(name),
            toolRevision: () => workletToolRegistry.revision,
            revert: (name, request, expectedPermissions) =>
                requireWorkletManager(worklets).revert(
                    name,
                    request,
                    expectedPermissions === undefined ? {} : { permissions: expectedPermissions },
                ),
            uninstall: (name) => requireWorkletManager(worklets).uninstall(name),
            update: (name, request, sourceFileSystem, expectedPermissions) =>
                requireWorkletManager(worklets).update(
                    name,
                    request,
                    sourceFileSystem,
                    expectedPermissions === undefined ? {} : { permissions: expectedPermissions },
                ),
        });
        store = new PersistentSessionStore({
            createRuntime: (options) => {
                const ownerInstanceId = options.ownerInstanceId ?? p2pIdentity.instanceId;
                const scopedProviders =
                    p2pCredentialRuntimeRegistry?.providers(ownerInstanceId) ?? availableProviders;
                return createCodingAssistantAgent({
                    ...options,
                    // What a provider says about the account while it answers is
                    // both the daemon's freshest reading and the session's, so
                    // the session is told the complete merged picture.
                    onAccountUsage: (usage) => {
                        const merged = credentialUsageRouter.record(ownerInstanceId, usage);
                        options.onAccountUsage?.(merged);
                    },
                    plugins,
                    worklets: workletsFor(options.sessionId ?? options.agentId ?? "standalone"),
                    providerUsage: {
                        current: () =>
                            Promise.all(
                                Object.keys(scopedProviders).map((providerId) =>
                                    credentialUsageRouter.entry(ownerInstanceId, providerId),
                                ),
                            ),
                    },
                    providers: scopedProviders,
                    protectedPaths: resolveProtectedPaths(options.cwd, machineProtectedPaths),
                    resolveInferenceMaxRetries: () => runtimeSettings.inferenceMaxRetries,
                });
            },
            databasePath: paths.databasePath,
            ...(loadedConfig.config.docker === undefined
                ? {}
                : { defaultDocker: loadedConfig.config.docker }),
            durableGlobalEventQueue: loadedConfig.config.settings.durableGlobalEventQueue,
            presence: createConfiguredPresenceStore(loadedConfig.config.presence),
            mcpToolProvider,
            localInstanceId: p2pIdentity.instanceId,
            modelCatalog,
            resolveModelCatalog: (ownerInstanceId) =>
                p2pCredentialRuntimeRegistry?.catalog(ownerInstanceId) ?? modelCatalog,
            workspacesDirectory: getManagedWorkspacesDirectory(),
            workspaceFeatures: {
                crossWorkspace: loadedConfig.config.features.crossWorkspace,
                workspaces: loadedConfig.config.features.workspaces,
            },
            ...(happyModule === undefined
                ? {}
                : { onSessionAccess: (session) => happySyncService?.attach(session) }),
            onSessionEvent: (event, session) => {
                recordProviderFailure(daemonLog, event);
                if (happyModule !== undefined) happySyncService?.observe(event, session);
                if (store !== undefined && gitStateTracker !== undefined) {
                    const identity = session?.projectIdentity();
                    markGitStateFromSessionEvent(
                        event,
                        store,
                        gitStateTracker,
                        ...(identity === undefined ? [] : ([identity] as const)),
                    );
                }
            },
            onWorkspaceBranchError: (error, projectId, workspaceId) => {
                daemonLog.record(
                    "warning",
                    "workspace_branch_rename_failed",
                    "Rig renamed the workspace, but its Git branch kept the name it already had.",
                    {
                        error: errorToMessage(error),
                        projectId,
                        workspaceId,
                    },
                );
            },
            onWorkspaceCleanupError: (error, projectId, workspaceId) => {
                daemonLog.record(
                    "warning",
                    "workspace_cleanup_failed",
                    "Rig archived the workspace, but could not remove all of its local residue.",
                    {
                        error: errorToMessage(error),
                        projectId,
                        workspaceId,
                    },
                );
            },
            taskDrain,
        });
        const githubSecretSync = new GitHubSecretSync({
            register: (secret) => {
                store?.registerSpecialSecret(secret);
            },
            unregister: () => {
                store?.unregisterSpecialSecret("github");
            },
        });
        try {
            await githubSecretSync.refresh();
        } catch {
            // GitHub credentials are optional; a failed refresh must not stop the daemon.
        }
        const githubSecretRefreshLoop = githubSecretSync.run(shutdown.signal);
        shutdown.register("GitHub credential refresh", () => githubSecretRefreshLoop);
        const activeStore = store;
        const p2pPeerTrustStore = new P2pPeerTrustStore(activeStore);
        const p2pNode: {
            name: string;
            primaryId?: string;
            role: "primary" | "secondary";
        } = {
            name: loadedConfig.config.p2p.name,
            ...(loadedConfig.config.p2p.primaryId === undefined
                ? {}
                : { primaryId: loadedConfig.config.p2p.primaryId }),
            role: loadedConfig.config.p2p.role,
        };
        let assignP2pPrimary = Promise.resolve();
        const canP2pPeerConfigure = (peerId: string): boolean => {
            if (p2pNode.role !== "secondary" || p2pNode.primaryId !== peerId) return false;
            try {
                return p2pPeerTrustStore.peers().some((peer) => peer.instanceId === peerId);
            } catch {
                return false;
            }
        };
        const isTrustedP2pPeer = (peerId: string): boolean => {
            try {
                return p2pPeerTrustStore.peers().some((peer) => peer.instanceId === peerId);
            } catch {
                return false;
            }
        };
        const setP2pPrimaryIfUnset = (primaryId: string): Promise<void> => {
            const assignment = assignP2pPrimary.then(async () => {
                if (p2pNode.primaryId !== undefined) return;
                await writeP2pNodeSettings({ primaryId, role: "secondary" });
                p2pNode.primaryId = primaryId;
                p2pNode.role = "secondary";
            });
            assignP2pPrimary = assignment.catch(() => undefined);
            return assignment;
        };
        try {
            await recoverP2pPairings(p2pPeerTrustStore, setP2pPrimaryIfUnset);
        } catch (error) {
            daemonLog.record(
                "warning",
                "p2p_pairing_recovery_failed",
                "Rig could not finish a confirmed P2P pairing.",
                { error: errorToMessage(error) },
            );
        }
        p2pCredentialStore = new P2pCredentialStore({
            database: activeStore,
            identity: p2pIdentity,
        });
        p2pCredentialRuntimeRegistry = new P2pCredentialRuntimeRegistry({
            localCatalog: modelCatalog,
            localInstanceId: p2pIdentity.instanceId,
            localName: () => p2pNode.name,
            localProviders: availableProviders,
            peers: () => p2pPeerTrustStore.peers(),
            runtimeDirectory: join(paths.directory, "p2p-credential-runtime"),
            store: p2pCredentialStore,
        });
        rigProfiles = new RigProfileStore({
            database: activeStore,
            localInstanceId: p2pIdentity.instanceId,
            publish: (event) => {
                activeStore.globalEventQueue.publishLive(event);
                activeStore.liveEvents.publish(event);
                p2pProfileReplicator?.syncProfile(event.data.profileId, event.data.version);
            },
        });
        {
            try {
                const irohSecret = await loadOrCreateIrohSecretKey(paths.irohSecretKeyPath);
                p2pPairingService = new P2pPairingService({
                    config: loadedConfig.config.p2p.iroh,
                    identity: p2pIdentity,
                    name: () => p2pNode.name,
                    onPeerTrusted: (peer) => {
                        p2pNetwork?.addTrustedPeer(peer);
                        p2pProfileReplicator?.peerChanged(peer.instanceId);
                        p2pCredentialRuntimeRegistry?.refresh();
                        p2pCredentialReplicator?.peerChanged(peer.instanceId);
                    },
                    peerTrustStore: p2pPeerTrustStore,
                    setPrimaryIfUnset: setP2pPrimaryIfUnset,
                    stableIrohEndpointId: irohSecret.public().toString(),
                    stableIrohEndpointTicket: async () => {
                        const ticket = await p2pNetwork?.irohEndpointTicket();
                        if (ticket === undefined) {
                            throw new Error("The stable Iroh P2P endpoint is unavailable.");
                        }
                        return ticket;
                    },
                });
            } catch (error) {
                daemonLog.record(
                    "warning",
                    "p2p_pairing_unavailable",
                    "P2P invitation and join are unavailable.",
                    { error: errorToMessage(error) },
                );
            }
        }
        const createP2pStatusEventId = createEventIdFactory();
        const credentialConnectedPeers = new Set<string>();
        const publishP2pStatus = (status: P2pStatus): void => {
            const event: GlobalLiveEvent = {
                createdAt: Date.now(),
                data: { status },
                id: createP2pStatusEventId(),
                type: "p2p_status_changed",
            };
            activeStore.globalEventQueue.publishLive(event);
            activeStore.liveEvents.publish(event);
            const connected = new Set(
                status.transports.flatMap((transport) =>
                    transport.state === "ready"
                        ? transport.peers.flatMap((peer) =>
                              peer.status === "connected" && peer.peerId !== undefined
                                  ? [peer.peerId]
                                  : [],
                          )
                        : [],
                ),
            );
            for (const peerId of connected) {
                if (!credentialConnectedPeers.has(peerId)) {
                    p2pCredentialReplicator?.peerChanged(peerId);
                }
            }
            credentialConnectedPeers.clear();
            for (const peerId of connected) credentialConnectedPeers.add(peerId);
        };
        p2pNetwork = await P2pNetwork.create({
            config: loadedConfig.config.p2p,
            ...(p2pIdentity === undefined ? {} : { identity: p2pIdentity }),
            identityPath: paths.p2pIdentityPath,
            irohSecretKeyPath: paths.irohSecretKeyPath,
            onStatusChange: publishP2pStatus,
            onTransportUnavailable: (transport, error) => {
                daemonLog.record(
                    "warning",
                    "p2p_transport_unavailable",
                    "A P2P transport is unavailable.",
                    { error: errorToMessage(error), transport },
                );
            },
            peerTrustStore: p2pPeerTrustStore,
            serveRequest: createServeP2pHttpRequest({
                allowRequest: (peerId, request) =>
                    loadedConfig.config.p2p.exposeApi ||
                    ((isP2pCredentialPath(request.path) || isP2pProfilePath(request.path)) &&
                        isTrustedP2pPeer(peerId)) ||
                    (canP2pPeerConfigure(peerId) && isP2pConfigurationPath(request.path)),
                socketPath,
                token,
            }),
            serveTunnel: createServeP2pTunnel({ socketPath, token }),
        });
        p2pCredentialReplicator = new P2pCredentialReplicator({
            listPeers: () => p2pPeerTrustStore.peers(),
            network: p2pNetwork,
            onError: (peerId, error) => {
                daemonLog.record(
                    "warning",
                    "p2p_credential_replication_failed",
                    "Rig could not synchronize inference credentials with a peer Rig.",
                    { error: errorToMessage(error), peerId },
                );
            },
            snapshot: async () =>
                p2pCredentialStore!.prepareOwnSnapshot(
                    await createLocalCredentialSnapshot({
                        credentialRecoveryDirectory: join(
                            paths.directory,
                            "p2p-credential-owner-recovery",
                        ),
                        owner: {
                            instanceId: p2pIdentity.instanceId,
                            publicKey: p2pIdentity.publicKey,
                        },
                        providers: availableProviders,
                    }),
                ),
            store: p2pCredentialStore,
        });
        p2pCredentialReplicator.syncAll();
        if (rigProfiles !== undefined && p2pIdentity !== undefined) {
            p2pProfileReplicator = new P2pProfileReplicator({
                listPeerIds: () => p2pPeerTrustStore.peers().map((peer) => peer.instanceId),
                localInstanceId: p2pIdentity.instanceId,
                network: p2pNetwork,
                onError: (peerId, error) => {
                    daemonLog.record(
                        "warning",
                        "p2p_profile_replication_failed",
                        "Rig could not synchronize a human profile with a secondary Rig.",
                        { error: errorToMessage(error), peerId },
                    );
                },
                profiles: rigProfiles,
            });
            p2pProfileReplicator.syncAll({ recheckTargets: true });
        }
        const irohStatus = p2pNetwork
            .status()
            .transports.find(
                (transport) => transport.transport === "iroh" && transport.state === "ready",
            );
        if (irohStatus?.state === "ready") {
            daemonLog.record("info", "iroh_started", "Rig P2P networking is ready.", {
                endpointId: irohStatus.localAddress,
                instanceId: p2pNetwork.status().instanceId,
                peers: p2pPeerTrustStore
                    .peers()
                    .filter((peer) => peer.connections.iroh !== undefined).length,
                ...(loadedConfig.config.p2p.iroh.relayUrl === undefined
                    ? {}
                    : { relayUrl: loadedConfig.config.p2p.iroh.relayUrl }),
            });
        }
        shutdown.register("p2p", async () => {
            await p2pPairingService?.close();
            await p2pProfileReplicator?.close();
            await p2pCredentialReplicator?.close();
            await p2pNetwork?.close();
        });
        const startedPluginManager = (pluginManager = new PluginManager({
            daemonLog,
            ...(loadedConfig.config.docker === undefined
                ? {}
                : { defaultDocker: loadedConfig.config.docker }),
            listProviderUsage: () => providerUsageTracker?.all() ?? [],
            generatedMedia: createGeneratedMediaStore({
                hostDirectory: getGeneratedDirectory(),
            }),
            mcpRegistry: pluginMcpRegistry,
            store,
        }));
        const pluginsStarted = startedPluginManager.start().catch((error: unknown) => {
            daemonLog.record(
                "error",
                "plugins_unavailable",
                "Rig could not load the plugins folder.",
                {
                    error: errorToMessage(error),
                    pluginsDirectory: startedPluginManager.directory,
                },
            );
        });
        shutdown.register("plugins", async () => {
            await startedPluginManager.close();
            await pluginsStarted;
        });
        const workletManager = new WorkletManager({
            publish: (event) => {
                activeStore.globalEventQueue.publishLive(event);
                activeStore.liveEvents.publish(event);
            },
            registry: workletToolRegistry,
            store: store.worklets,
        });
        worklets = workletManager;
        const workletsStarted = workletManager.start().catch((error: unknown) => {
            daemonLog.record(
                "error",
                "worklets_unavailable",
                "Rig could not start the worklets folder.",
                { error: errorToMessage(error), workletsDirectory: workletManager.directory },
            );
        });
        shutdown.register("worklets", async () => {
            await workletManager.close();
            await workletsStarted;
        });
        await Promise.all([pluginsStarted, workletsStarted]);
        if (stopping) return;
        if (happyModule !== undefined && happyConfiguration !== undefined) {
            try {
                const service = new happyModule.HappySyncService({
                    configuration: happyConfiguration,
                    createSession: (id, request) =>
                        store!.createWithId(
                            id,
                            configureSessionRequest(request, loadedConfig.config.docker, () =>
                                store!.queryProjectSettings(request.cwd),
                            ),
                        ),
                    databasePath: paths.databasePath,
                    getSubagents: (sessionId) => store?.listSubagents(sessionId) ?? [],
                    getProjectContext: (session) => {
                        const identity = session.projectIdentity();
                        if (identity === undefined) return undefined;
                        const project = store?.getProject(identity.projectId);
                        if (project === undefined) return undefined;
                        const workspace =
                            identity.workspaceId === undefined
                                ? undefined
                                : store?.getWorkspace(project.id, identity.workspaceId);
                        return {
                            project,
                            ...(workspace === undefined ? {} : { workspace }),
                        };
                    },
                    loadSession: (sessionId) => store?.get(sessionId),
                    modelCatalog,
                });
                service.start();
                happySyncService = service;
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                daemonLog.record(
                    "warning",
                    "daemon_happy_unavailable",
                    "Happy sync is unavailable.",
                    { error: errorToMessage(error) },
                );
            }
        }
        registerRigDebugRoot({
            kind: "daemon",
            paths,
            server,
            store,
        });
        if (stopping) {
            taskDrain.beginClose();
            return;
        }

        createProtocolHttpServer(
            {
                inferenceMaxRetries: runtimeSettings.inferenceMaxRetries,
                ...(loadedConfig.config.docker === undefined
                    ? {}
                    : { defaultDocker: loadedConfig.config.docker }),
                ...(store.globalEventQueue === undefined
                    ? {}
                    : { globalEventQueue: store.globalEventQueue }),
                ...(gitStateTracker === undefined ? {} : { gitStateTracker }),
                modelCatalog,
                resolveModelCatalog: (ownerInstanceId) =>
                    p2pCredentialRuntimeRegistry?.catalog(ownerInstanceId) ?? modelCatalog,
                happyCloud: store.happyCloud,
                p2pNetwork,
                ...(p2pPairingService === undefined ? {} : { p2pPairing: p2pPairingService }),
                p2pNode: () => ({ ...p2pNode }),
                p2pStatus: () => p2pNetwork?.status() ?? { name: p2pNode.name, transports: [] },
                ...(rigProfiles === undefined ? {} : { profiles: rigProfiles }),
                replaceP2pCredentials: (authenticatedOwnerId, envelope) => {
                    if (
                        store === undefined ||
                        p2pCredentialRuntimeRegistry === undefined ||
                        p2pCredentialStore === undefined
                    ) {
                        throw new Error("P2P credential provisioning is unavailable.");
                    }
                    const peer = p2pPeerTrustStore
                        .peers()
                        .find((candidate) => candidate.instanceId === authenticatedOwnerId);
                    if (peer === undefined) {
                        throw new Error("That credential owner is not a trusted peer Rig.");
                    }
                    const result = p2pCredentialStore.replaceEncrypted(
                        authenticatedOwnerId,
                        peer.publicKey,
                        envelope,
                    );
                    const runtimeChanged = p2pCredentialRuntimeRegistry.refresh();
                    if (runtimeChanged) {
                        credentialUsageRouter.clearProvisionedCaches();
                        for (const session of store.loadedSessions()) {
                            session.refreshInferenceScope(
                                p2pCredentialRuntimeRegistry.catalog(session.ownerInstanceId),
                            );
                        }
                    }
                    return result;
                },
                ...(rigProfiles === undefined || p2pNetwork === undefined
                    ? {}
                    : {
                          prepareP2pRequest: async ({ body, path, peerId, signal }) => {
                              await p2pCredentialReplicator?.ensureForRequest(peerId, signal);
                              await replicateProfileForP2pRequest({
                                  body,
                                  network: p2pNetwork!,
                                  onSynchronized: (synchronizedPeerId, profileId, version) =>
                                      p2pProfileReplicator?.profileSynchronized(
                                          synchronizedPeerId,
                                          profileId,
                                          version,
                                      ),
                                  path,
                                  peerId,
                                  profiles: rigProfiles!,
                                  signal,
                              });
                          },
                      }),
                canP2pPeerConfigure,
                canP2pPeerProvision: isTrustedP2pPeer,
                plugins,
                ...(worklets === undefined ? {} : { worklets }),
                getProviderQuota: (providerId, ownerInstanceId, credential) =>
                    credentialUsageRouter.quota(ownerInstanceId, providerId, credential),
                listProviderUsage: async (ownerInstanceId) => {
                    const resolvedOwnerInstanceId = ownerInstanceId ?? p2pIdentity.instanceId;
                    const providers =
                        p2pCredentialRuntimeRegistry?.providers(resolvedOwnerInstanceId) ??
                        availableProviders;
                    return Promise.all(
                        Object.keys(providers).map((providerId) =>
                            credentialUsageRouter.entry(resolvedOwnerInstanceId, providerId),
                        ),
                    );
                },
                onDaemonConfigChange: async (config) => {
                    await writeDaemonSettings(config.settings, {}, config.p2p.name);
                    const globalEventQueue = store?.setDurableGlobalEventQueue(
                        config.settings.durableGlobalEventQueue,
                    );
                    if (globalEventQueue === undefined) return undefined;
                    runtimeSettings.inferenceMaxRetries = config.settings.inferenceMaxRetries;
                    p2pNode.name = config.p2p.name;
                    p2pNetwork?.setName(config.p2p.name);
                    if (p2pNetwork !== undefined) publishP2pStatus(p2pNetwork.status());
                    return {
                        inferenceMaxRetries: runtimeSettings.inferenceMaxRetries,
                        globalEventQueue,
                    };
                },
                ...(happyModule === undefined
                    ? {}
                    : {
                          onReloadHappy: async () => {
                              if (stopping) return false;
                              return runHappyLifecycle(async () => {
                                  if (stopping) return false;
                                  const nextConfiguration =
                                      await happyModule.importHappyCredentials({
                                          machineScope: socketPath,
                                      });
                                  if (stopping || nextConfiguration === undefined) return false;
                                  let next: HappySyncService;
                                  try {
                                      next = new happyModule.HappySyncService({
                                          configuration: nextConfiguration,
                                          createSession: (id, request) =>
                                              store!.createWithId(
                                                  id,
                                                  configureSessionRequest(
                                                      request,
                                                      loadedConfig.config.docker,
                                                      () =>
                                                          store!.queryProjectSettings(request.cwd),
                                                  ),
                                              ),
                                          databasePath: paths.databasePath,
                                          getSubagents: (sessionId) =>
                                              store?.listSubagents(sessionId) ?? [],
                                          getProjectContext: (session) => {
                                              const identity = session.projectIdentity();
                                              if (identity === undefined) return undefined;
                                              const project = store?.getProject(identity.projectId);
                                              if (project === undefined) return undefined;
                                              const workspace =
                                                  identity.workspaceId === undefined
                                                      ? undefined
                                                      : store?.getWorkspace(
                                                            project.id,
                                                            identity.workspaceId,
                                                        );
                                              return {
                                                  project,
                                                  ...(workspace === undefined ? {} : { workspace }),
                                              };
                                          },
                                          loadSession: (sessionId) => store?.get(sessionId),
                                          modelCatalog,
                                      });
                                  } catch (error) {
                                      if (isDatabaseFailure(error)) throw error;
                                      daemonLog.record(
                                          "error",
                                          "daemon_happy_reload_failed",
                                          "Happy sync could not reload.",
                                          { error: errorToMessage(error) },
                                      );
                                      return false;
                                  }
                                  const previous = happySyncService;
                                  happySyncService = undefined;
                                  try {
                                      await previous?.close();
                                  } catch (error) {
                                      if (isDatabaseFailure(error)) throw error;
                                      daemonLog.record(
                                          "warning",
                                          "daemon_happy_previous_close_failed",
                                          "The previous Happy sync connection could not close cleanly.",
                                          { error: errorToMessage(error) },
                                      );
                                  }
                                  next.start();
                                  happySyncService = next;
                                  for (const session of store!.loadedSessions()) {
                                      next.attach(session);
                                  }
                                  return true;
                              });
                          },
                      }),
                onStartInspector: async () => {
                    const inspectorUrl = openNodeInspector();
                    await writeServerRegistry();
                    return { inspectorUrl };
                },
                onShutdown: () => stopServer("Shutdown requested through the daemon protocol."),
                store,
                taskDrain,
                token,
            },
            server,
        );
        server.off("request", startupRequestListener);
        daemonLog.record("info", "daemon_ready", "Rig daemon is ready.", {
            databasePath: paths.databasePath,
            socketPath,
        });
    }
}

function requirePluginManager(manager: PluginManager | undefined): PluginManager {
    if (manager === undefined)
        throw new Error("Rig is still starting, so plugins are unavailable.");
    return manager;
}

function requireWorkletManager(manager: WorkletManager | undefined): WorkletManager {
    if (manager === undefined)
        throw new Error("Rig is still starting, so worklets are unavailable.");
    return manager;
}

function isP2pConfigurationPath(path: string): boolean {
    const pathname = new URL(path, "http://rig.local").pathname;
    return (
        pathname === "/config" ||
        pathname === "/config/instructions" ||
        pathname === "/config/security"
    );
}

function isP2pProfilePath(path: string): boolean {
    const pathname = new URL(path, "http://rig.local").pathname;
    return pathname === "/profiles" || /^\/profiles\/[a-z][a-z0-9]+$/u.test(pathname);
}

function isP2pCredentialPath(path: string): boolean {
    return new URL(path, "http://rig.local").pathname === "/inference-credentials";
}

async function writeRegistry(path: string, payload: unknown): Promise<void> {
    const file = await open(path, "w", 0o600);
    try {
        await file.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
        await file.chmod(0o600);
    } finally {
        await file.close();
    }
}
