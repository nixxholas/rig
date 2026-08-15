import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import type { AppletFeature } from "@slopus/happy-agent-features";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import { configureConversationRequest } from "../conversations/configureConversationRequest.js";
import { DocumentRepository } from "../documents/DocumentRepository.js";
import { FolderRepository } from "../folders/FolderRepository.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import { InMemoryGlobalEventQueue } from "../global-event/InMemoryGlobalEventQueue.js";
import { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";
import { PersistentGlobalEventQueue } from "../global-event/PersistentGlobalEventQueue.js";
import { shouldPublishGlobalEvent } from "../global-event/shouldPublishGlobalEvent.js";
import { HappyCloudService } from "../happy-cloud/HappyCloudService.js";
import { withWorkerContext } from "../observability/index.js";
import { getDatabaseScope, withDatabase } from "../persistence/databaseContext.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../persistence/database/migrateSessionDatabase.js";
import {
    openSessionDatabase,
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { queryRigDataEpoch } from "../persistence/database/queryRigDataEpoch.js";
import { querySessionDatabaseVersion } from "../persistence/database/querySessionDatabaseVersion.js";
import { isSessionDatabaseTransaction } from "../persistence/database/SessionDatabase.js";
import {
    deferSessionTransactionCommit,
    runSessionTransaction,
} from "../persistence/database/SessionTransactionContext.js";
import { SqliteHappyCloudPersistence } from "../persistence/happy-cloud/SqliteHappyCloudPersistence.js";
import { queryRigProfile } from "../persistence/profile/queryRigProfiles.js";
import { querySecretRegistrations } from "../persistence/conversations/querySecretRegistrations.js";
import { secretRegister } from "../persistence/conversations/secretRegister.js";
import { querySlotScopeTargetExists } from "../persistence/slots/querySlotScopeTargetExists.js";
import { PresenceStore, resolvePresences } from "../presence/index.js";
import {
    createEventIdFactory,
    isLiveGlobalEvent,
    type CreateSessionRequest,
    type GlobalEvent,
} from "../protocol/index.js";
import { p2pInstanceIdSchema } from "../protocol/P2pIdentityProtocol.js";
import { ProjectRepository, type ProjectRepositoryOptions } from "../project/ProjectRepository.js";
import { SecretRegistry, type EnvironmentSecretRegistration } from "../secrets/index.js";
import { SlotEntryStore } from "../slots/SlotEntryStore.js";
import {
    ProjectRemoteTerminalStore,
    type ProjectRemoteTerminalContext,
    type RemoteTerminalScope,
} from "../terminal/index.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";

export interface DaemonResourcesOptions {
    applets: Pick<AppletFeature, "get">;
    databasePath: string;
    defaultDocker?: CreateSessionRequest["docker"];
    durableGlobalEventQueue?: boolean;
    gitCredentialBroker?: ProjectRepositoryOptions["gitCredentialBroker"];
    homeDirectory?: string;
    localInstanceId?: string;
    now?: () => number;
    onWorkspaceBranchError?: ProjectRepositoryOptions["onWorkspaceBranchError"];
    onWorkspaceCleanupError?: ProjectRepositoryOptions["onWorkspaceCleanupError"];
    presence?: PresenceStore;
    projectClone?: ProjectRepositoryOptions["cloneRemote"];
    projectGit?: ProjectRepositoryOptions["git"];
    secrets?: readonly EnvironmentSecretRegistration[];
    stateDirectory?: string;
    taskDrain?: TaskDrain;
    workspacesDirectory?: string;
}

interface DaemonResourceParts {
    dataEpoch: string;
    dataSchemaVersion: number;
    database: SessionDatabase;
    documents: DocumentRepository;
    folders: FolderRepository;
    globalEvents: GlobalEventQueue;
    happyCloud: HappyCloudService;
    happyCloudPersistence: SqliteHappyCloudPersistence;
    liveEvents: LiveGlobalEventQueue;
    localInstanceId: string;
    presence: PresenceStore;
    presenceUnsubscribe: () => void;
    projects: ProjectRepository;
    remoteTerminals: ProjectRemoteTerminalStore;
    secrets: SecretRegistry;
    slots: SlotEntryStore;
}

/**
 * Owns the daemon's concrete host resources.
 *
 * This is composition, not a facade: callers use the repositories and queues exposed below
 * directly. It holds no live conversations and owns no inference or agent features.
 */
export class DaemonResources {
    readonly dataEpoch: string;
    readonly dataSchemaVersion: number;
    readonly database: SessionDatabase;
    readonly documents: DocumentRepository;
    readonly folders: FolderRepository;
    readonly globalEvents: GlobalEventQueue;
    readonly happyCloud: HappyCloudService;
    readonly happyCloudPersistence: SqliteHappyCloudPersistence;
    readonly liveEvents: LiveGlobalEventQueue;
    readonly localInstanceId: string;
    readonly presence: PresenceStore;
    readonly projects: ProjectRepository;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    readonly secrets: SecretRegistry;
    readonly slots: SlotEntryStore;

    readonly #presenceUnsubscribe: () => void;
    #closePromise: Promise<void> | undefined;

    static async open(ctx: Context, options: DaemonResourcesOptions): Promise<DaemonResources> {
        if (options.databasePath !== ":memory:") {
            await mkdir(dirname(options.databasePath), { mode: 0o700, recursive: true });
        }
        const opened = await openSessionDatabase(ctx, options.databasePath);
        const database = opened.database;
        const databaseCtx = withDatabase(ctx, database);
        let presence: PresenceStore | undefined;
        let presenceUnsubscribe: (() => void) | undefined;
        let globalEvents: GlobalEventQueue | undefined;
        let liveEvents: LiveGlobalEventQueue | undefined;
        let projects: ProjectRepository | undefined;
        let remoteTerminals: ProjectRemoteTerminalStore | undefined;
        try {
            const localInstanceId = validOwnerInstanceId(options.localInstanceId ?? createId());
            await migrateSessionDatabase(databaseCtx, { localInstanceId });
            const dataEpoch = await queryRigDataEpoch(databaseCtx);
            const dataSchemaVersion = await querySessionDatabaseVersion(databaseCtx);
            if (dataSchemaVersion !== CURRENT_SESSION_DATABASE_VERSION) {
                throw new Error("The Rig database did not reach the current schema version.");
            }
            if (options.databasePath !== ":memory:") {
                await chmod(options.databasePath, 0o600);
            }

            const now = options.now ?? Date.now;
            globalEvents =
                options.durableGlobalEventQueue === true
                    ? await PersistentGlobalEventQueue.open(databaseCtx, database)
                    : new InMemoryGlobalEventQueue({ now });
            liveEvents = new LiveGlobalEventQueue({ now });
            const transaction = async <T>(
                requestCtx: Context,
                operation: (transactionCtx: Context) => T | Promise<T>,
            ): Promise<T> => {
                if (database.closed) throw new Error("The Rig database is closed.");
                requestCtx = withDatabase(requestCtx, database);
                if (isSessionDatabaseTransaction(getDatabaseScope(requestCtx))) {
                    return await operation(requestCtx);
                }
                return await runSessionTransaction(requestCtx, operation);
            };
            const afterTransactionCommit = (
                requestCtx: Context,
                callback: (postCommitCtx: Context) => void | Promise<void>,
            ): Promise<void> => {
                const postCommitCtx = withDatabase(requestCtx, database);
                return deferSessionTransactionCommit(() => callback(postCommitCtx), database);
            };
            const publishGlobalEvent = async (
                requestCtx: Context,
                event: GlobalEvent,
            ): Promise<void> => {
                if (!("sessionId" in event)) {
                    await afterTransactionCommit(requestCtx, () => {
                        liveEvents!.publish(event);
                    });
                }
                if (isLiveGlobalEvent(event)) {
                    await afterTransactionCommit(requestCtx, () => {
                        globalEvents!.publishLive(event);
                    });
                    return;
                }
                if (!shouldPublishGlobalEvent(event)) return;
                if (!globalEvents!.durable) {
                    await afterTransactionCommit(requestCtx, async (postCommitCtx) => {
                        const entry = await globalEvents!.append(postCommitCtx, event);
                        if (entry !== undefined) globalEvents!.publish(entry);
                    });
                    return;
                }
                const entry = await globalEvents!.append(requestCtx, event);
                if (entry !== undefined) {
                    await afterTransactionCommit(requestCtx, () => {
                        globalEvents!.publish(entry);
                    });
                }
            };

            presence =
                options.presence ??
                new PresenceStore({
                    now,
                    presences: resolvePresences(),
                });
            const createPresenceEventId = createEventIdFactory({ now });
            const presenceContext = createRootContext().named("daemon-presence-events");
            presenceUnsubscribe = presence.onChange((state) => {
                void publishGlobalEvent(presenceContext, {
                    createdAt: now(),
                    data: { presence: state },
                    id: createPresenceEventId(),
                    type: "presence_changed",
                });
            });

            const secrets = new SecretRegistry();
            const loadedSecrets = await querySecretRegistrations(databaseCtx);
            for (const registration of loadedSecrets.registrations) {
                secrets.register(registration);
            }
            for (const variable of loadedSecrets.environmentVariables) {
                secrets.rememberEnvironmentVariables(variable.secretId, [variable.name]);
            }
            for (const registration of options.secrets ?? []) {
                await secretRegister(databaseCtx, registration);
                secrets.register(registration);
            }

            projects = await ProjectRepository.open(databaseCtx, {
                afterTransactionCommit,
                ...(options.projectClone === undefined
                    ? {}
                    : { cloneRemote: options.projectClone }),
                database,
                ...(options.gitCredentialBroker === undefined
                    ? {}
                    : { gitCredentialBroker: options.gitCredentialBroker }),
                ...(options.projectGit === undefined ? {} : { git: options.projectGit }),
                ...(options.homeDirectory === undefined
                    ? {}
                    : { homeDirectory: options.homeDirectory }),
                localInstanceId,
                now,
                onEvent: publishGlobalEvent,
                ...(options.onWorkspaceBranchError === undefined
                    ? {}
                    : { onWorkspaceBranchError: options.onWorkspaceBranchError }),
                ...(options.onWorkspaceCleanupError === undefined
                    ? {}
                    : { onWorkspaceCleanupError: options.onWorkspaceCleanupError }),
                resolveGitSecret: (kind) => secrets.resolveSpecial(kind).GH_TOKEN,
                resolveProfile: (profileId) =>
                    withWorkerContext("project-profile-resolve", (workerCtx) =>
                        queryRigProfile(withDatabase(workerCtx, database), profileId),
                    ),
                ...(options.stateDirectory !== undefined
                    ? { stateDirectory: options.stateDirectory }
                    : options.databasePath === ":memory:"
                      ? {}
                      : { stateDirectory: dirname(options.databasePath) }),
                ...(options.taskDrain === undefined ? {} : { taskDrain: options.taskDrain }),
                transaction,
                ...(options.workspacesDirectory === undefined
                    ? {}
                    : { workspacesDirectory: options.workspacesDirectory }),
            });
            const folders = new FolderRepository({
                database,
                ...(options.homeDirectory === undefined
                    ? {}
                    : { homeDirectory: options.homeDirectory }),
                now,
                onEvent: publishGlobalEvent,
                transaction: async (requestCtx, operation) =>
                    await transaction(requestCtx, operation),
            });
            const documents = new DocumentRepository({
                database,
                now,
                onEvent: publishGlobalEvent,
                transaction: async (requestCtx, operation) =>
                    await transaction(requestCtx, operation),
            });
            const createTerminalEventId = createEventIdFactory({ now });
            remoteTerminals = new ProjectRemoteTerminalStore({
                onChange: (_requestCtx, scope, terminals) => {
                    const event = {
                        createdAt: now(),
                        data: { terminals },
                        id: createTerminalEventId(),
                        projectId: scope.projectId,
                        type: "remote_terminals_changed" as const,
                        ...(scope.workspaceId === undefined
                            ? {}
                            : { workspaceId: scope.workspaceId }),
                    };
                    globalEvents!.publishLive(event);
                    liveEvents!.publish(event);
                },
                resolveContext: (requestCtx, scope) =>
                    resolveRemoteTerminalContext(
                        requestCtx,
                        projects!,
                        scope,
                        options.defaultDocker,
                    ),
            });
            const slots = new SlotEntryStore({
                applets: options.applets,
                database,
                now,
                publish: publishGlobalEvent,
                sessionExists: (requestCtx, sessionId) =>
                    querySlotScopeTargetExists(
                        withDatabase(requestCtx, database),
                        "session",
                        sessionId,
                    ),
            });
            const happyCloudPersistence = new SqliteHappyCloudPersistence(database);
            const happyCloud = new HappyCloudService({
                now,
                persistence: happyCloudPersistence,
                publish: publishGlobalEvent,
            });
            return new DaemonResources({
                dataEpoch,
                dataSchemaVersion,
                database,
                documents,
                folders,
                globalEvents,
                happyCloud,
                happyCloudPersistence,
                liveEvents,
                localInstanceId,
                presence,
                presenceUnsubscribe,
                projects,
                remoteTerminals,
                secrets,
                slots,
            });
        } catch (error) {
            presenceUnsubscribe?.();
            presence?.close();
            const cleanup = await Promise.allSettled([
                ...(remoteTerminals === undefined ? [] : [remoteTerminals.close(ctx)]),
                ...(projects === undefined ? [] : [projects.close(ctx)]),
                database.close(ctx),
            ]);
            liveEvents?.close();
            globalEvents?.deactivate();
            const cleanupFailures = cleanup
                .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                .map((result) => result.reason);
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    "Rig resource startup failed and cleanup also failed.",
                );
            }
            throw error;
        }
    }

    private constructor(parts: DaemonResourceParts) {
        this.dataEpoch = parts.dataEpoch;
        this.dataSchemaVersion = parts.dataSchemaVersion;
        this.database = parts.database;
        this.documents = parts.documents;
        this.folders = parts.folders;
        this.globalEvents = parts.globalEvents;
        this.happyCloud = parts.happyCloud;
        this.happyCloudPersistence = parts.happyCloudPersistence;
        this.liveEvents = parts.liveEvents;
        this.localInstanceId = parts.localInstanceId;
        this.presence = parts.presence;
        this.#presenceUnsubscribe = parts.presenceUnsubscribe;
        this.projects = parts.projects;
        this.remoteTerminals = parts.remoteTerminals;
        this.secrets = parts.secrets;
        this.slots = parts.slots;
    }

    close(ctx: Context): Promise<void> {
        this.#closePromise ??= this.#close(ctx);
        return this.#closePromise;
    }

    async #close(ctx: Context): Promise<void> {
        this.#presenceUnsubscribe();
        this.presence.close();
        const failures: unknown[] = [];
        for (const result of await Promise.allSettled([
            this.remoteTerminals.close(ctx),
            this.projects.close(ctx),
        ])) {
            if (result.status === "rejected") failures.push(result.reason);
        }
        this.liveEvents.close();
        this.globalEvents.deactivate();
        try {
            await this.database.close(ctx);
        } catch (error) {
            failures.push(error);
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "Rig could not close every daemon resource.");
        }
    }
}

async function resolveRemoteTerminalContext(
    ctx: Context,
    projects: Pick<ProjectRepository, "getProject" | "getWorkspace" | "queryProjectSettings">,
    scope: RemoteTerminalScope,
    defaultDocker: CreateSessionRequest["docker"],
): Promise<ProjectRemoteTerminalContext> {
    const project = await projects.getProject(ctx, scope.projectId);
    if (project === undefined) throw new Error("Project not found.");
    if (project.archivedAt !== undefined) {
        throw new Error("Archived projects cannot open terminals.");
    }
    const workspace =
        scope.workspaceId === undefined
            ? undefined
            : await projects.getWorkspace(ctx, scope.projectId, scope.workspaceId);
    if (scope.workspaceId !== undefined && workspace === undefined) {
        throw new Error("Workspace not found.");
    }
    if (workspace !== undefined) {
        if (workspace.status !== "ready" || workspace.presence !== "present") {
            throw new Error("Only ready, available workspaces can open terminals.");
        }
        try {
            if (!(await stat(workspace.path)).isDirectory()) {
                throw new Error("The workspace path is not a directory.");
            }
        } catch (error) {
            if (
                error instanceof Error &&
                error.message === "The workspace path is not a directory."
            )
                throw error;
            throw new Error("The workspace directory is unavailable.", { cause: error });
        }
    }
    const cwd = workspace?.path ?? project.path;
    const docker = (
        await configureConversationRequest(
            { cwd },
            defaultDocker,
            async () => await projects.queryProjectSettings(ctx, cwd),
        )
    ).docker;
    return { cwd, ...(docker === undefined ? {} : { docker }) };
}

function validOwnerInstanceId(value: string): string {
    if (!Value.Check(p2pInstanceIdSchema, value)) {
        throw new Error("The daemon owner identity is invalid.");
    }
    return value;
}
