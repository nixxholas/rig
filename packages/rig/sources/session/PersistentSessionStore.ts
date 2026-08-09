import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import {
    createEventIdFactory,
    isLiveGlobalEvent,
    UNSORTED_SESSION_ARCHIVE_AFTER_MS,
} from "../protocol/index.js";
import type {
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateDocumentRequest,
    CreateFolderItemRequest,
    CreateFolderRequest,
    CreateProjectWorkspaceRequest,
    CreateRemoteProjectRequest,
    CreateSessionRequest,
    Document,
    DocumentCreatedBy,
    DocumentUpdatePage,
    EventId,
    Folder,
    FolderItem,
    GetTimelineRequest,
    GitChangeSnapshot,
    GitRepositoryFacts,
    GlobalEventQueueEntry,
    ModelCatalog,
    ListDocumentUpdatesRequest,
    MoveFolderItemRequest,
    MoveFolderRequest,
    Project,
    ProjectCreator,
    ProjectSettingsUpdate,
    ProjectWorkspace,
    ReorderRequest,
    GlobalEvent,
    RegisterProjectRequest,
    RegisterSecretRequest,
    SecretSummary,
    SessionEvent,
    SessionAgentMetadata,
    SessionActivityWait,
    SessionInterruption,
    SessionSummary,
    SharedFolderState,
    SessionScope,
    SessionTranscriptWindow,
    SubagentSummary,
    TimelineAgent,
    TransferSessionRequest,
    TransferSessionResponse,
    UpdateFolderRequest,
    WriteDocumentRequest,
    UpdateSecretRequest,
} from "../protocol/index.js";
import type { Message } from "../agent/types.js";
import {
    DEFAULT_WORKSPACE_FEATURES,
    InMemorySession,
    type InMemorySessionOptions,
    type InMemorySessionPersistence,
    type PersistedQueuedRun,
    type PersistedPendingContextMessage,
    type PersistedSessionMessage,
    type PersistedSessionState,
    type WorkspaceFeatures,
} from "./InMemorySession.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import { PersistentGlobalEventQueue } from "../global-event/PersistentGlobalEventQueue.js";
import { retriedSession } from "./retriedSession.js";
import type { SessionCreationOptions, SessionStore } from "./SessionStore.js";
import { p2pInstanceIdSchema } from "../protocol/P2pIdentityProtocol.js";
import type { McpToolProvider } from "../mcp/index.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import { isLiveOnlySessionEvent } from "./isLiveOnlySessionEvent.js";
import {
    SecretRegistry,
    type EnvironmentSecretRegistration,
    type SpecialSecretKind,
    type SpecialSecretRegistration,
} from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { ExternalToolCall } from "../external-tools/index.js";
import type { DurableUserInputCall } from "../user-input/index.js";
import type { DurableWait, ScheduledMessage } from "../scheduling/index.js";
import type { GitCommandRunner } from "../git/types.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { sharingStateReset } from "../persistence/sharing/index.js";
import { InMemoryGlobalEventQueue } from "../global-event/InMemoryGlobalEventQueue.js";
import { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";
import {
    ProjectRepository,
    type ProjectAvatarAsset,
    type ProjectRepositoryOptions,
    type ProjectSessionSettings,
} from "../project/ProjectRepository.js";
import { FolderRepository } from "../folders/FolderRepository.js";
import { DocumentRepository } from "../documents/DocumentRepository.js";
import { shouldPublishGlobalEvent } from "../global-event/shouldPublishGlobalEvent.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";
import {
    ProjectRemoteTerminalStore,
    type ProjectRemoteTerminalContext,
    type RemoteTerminalScope,
} from "../terminal/index.js";
import { SessionEventLog } from "./SessionEventLog.js";
import {
    sessionTranscriptWindow,
    transcriptRunFacts,
    type TranscriptEntry,
} from "./sessionTranscriptWindow.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../persistence/database/migrateSessionDatabase.js";
import { queryRigDataEpoch } from "../persistence/database/queryRigDataEpoch.js";
import { querySessionDatabaseVersion } from "../persistence/database/querySessionDatabaseVersion.js";
import { durablePermissionHandoff } from "../persistence/session/durablePermissionHandoff.js";
import { durableUserInputPrune } from "../persistence/session/durableUserInputPrune.js";
import { durableUserInputSave } from "../persistence/session/durableUserInputSave.js";
import { queryDurableUserInputs } from "../persistence/session/queryDurableUserInputs.js";
import { externalToolCallPrune } from "../persistence/session/externalToolCallPrune.js";
import { externalToolCallSave } from "../persistence/session/externalToolCallSave.js";
import { projectSecretAttach } from "../persistence/session/projectSecretAttach.js";
import { projectSecretDetach } from "../persistence/session/projectSecretDetach.js";
import { secretRegister } from "../persistence/session/secretRegister.js";
import { secretUnregister } from "../persistence/session/secretUnregister.js";
import { sessionAdvanceEventCursor } from "../persistence/session/sessionAdvanceEventCursor.js";
import { sessionAcceptQueuedRun } from "../persistence/session/sessionAcceptQueuedRun.js";
import { sessionAppendEvent } from "../persistence/session/sessionAppendEvent.js";
import { sessionClearMessages } from "../persistence/session/sessionClearMessages.js";
import { sessionDeleteQueuedRun } from "../persistence/session/sessionDeleteQueuedRun.js";
import { sessionFailQueuedRun } from "../persistence/session/sessionFailQueuedRun.js";
import { sessionReconcileTerminalRun } from "../persistence/session/sessionReconcileTerminalRun.js";
import { sessionRepairInterruptedTitles } from "../persistence/session/sessionRepairInterruptedTitles.js";
import { sessionRewind } from "../persistence/session/sessionRewind.js";
import { sessionSave } from "../persistence/session/sessionSave.js";
import { sessionSaveMessage } from "../persistence/session/sessionSaveMessage.js";
import { sessionSaveQueuedRun } from "../persistence/session/sessionSaveQueuedRun.js";
import { sessionSavePendingContextMessage } from "../persistence/session/sessionSavePendingContextMessage.js";
import { sessionStartQueuedRun } from "../persistence/session/sessionStartQueuedRun.js";
import { sessionDrainPendingContextMessages } from "../persistence/session/sessionDrainPendingContextMessages.js";
import {
    sessionPruneToolResults,
    type SessionToolResultPruneCursor,
} from "../persistence/session/sessionPruneToolResults.js";
import { sessionTransferWorkspace } from "../persistence/session/sessionTransferWorkspace.js";
import { sessionSetWorkspaceTransferState } from "../persistence/session/sessionSetWorkspaceTransferState.js";
import { queryWorkspaceHasAttachedSessions } from "../persistence/session/queryWorkspaceHasAttachedSessions.js";
import { durableWaitSave } from "../persistence/scheduling/durableWaitSave.js";
import { durableWaitPrune } from "../persistence/scheduling/durableWaitPrune.js";
import { scheduledMessageSave } from "../persistence/scheduling/scheduledMessageSave.js";
import { scheduledMessagePrune } from "../persistence/scheduling/scheduledMessagePrune.js";
import { queryNextPendingScheduledMessage } from "../persistence/scheduling/queryScheduledMessages.js";
import { queryExternalToolCalls } from "../persistence/session/queryExternalToolCalls.js";
import { queryFirstRootSessionIdForWorkspace } from "../persistence/session/queryFirstRootSessionIdForWorkspace.js";
import { queryInterruptedSessionCandidates } from "../persistence/session/queryInterruptedSessionCandidates.js";
import { queryProjectSecretIds } from "../persistence/session/queryProjectSecretIds.js";
import { queryRootSessionIdsForProject } from "../persistence/session/queryRootSessionIdsForProject.js";
import { queryWorkspaceSessions } from "../persistence/session/queryWorkspaceSessions.js";
import { queryWorkspaceQueuedSessionIds } from "../persistence/session/queryWorkspaceQueuedSessionIds.js";
import { queryExpiredUnsortedSessions } from "../persistence/session/queryExpiredUnsortedSessions.js";
import { querySecretRegistrations } from "../persistence/session/querySecretRegistrations.js";
import { querySessionEvents } from "../persistence/session/querySessionEvents.js";
import { querySessionHasEarlierTranscriptMessage } from "../persistence/session/querySessionHasEarlierTranscriptMessage.js";
import { querySessionHasLaterTranscriptMessage } from "../persistence/session/querySessionHasLaterTranscriptMessage.js";
import { querySessionIdByAgentId } from "../persistence/session/querySessionIdByAgentId.js";
import { queryUnarchivedSessionIdsForWorkspace } from "../persistence/session/queryUnarchivedSessionIdsForWorkspace.js";
import { querySessionOrderItems } from "../persistence/session/querySessionOrderItems.js";
import { querySessionRestore } from "../persistence/session/querySessionRestore.js";
import { querySessionSummaries } from "../persistence/session/querySessionSummaries.js";
import { querySessionTranscriptEvents } from "../persistence/session/querySessionTranscriptEvents.js";
import { querySessionTranscriptPage } from "../persistence/session/querySessionTranscriptPage.js";
import { querySessionAttachment } from "../persistence/session/querySessionAttachment.js";
import { querySessionTranscriptSince } from "../persistence/session/querySessionTranscriptSince.js";
import { querySubagentSummaries } from "../persistence/session/querySubagentSummaries.js";
import { queryTimelineAgents } from "../persistence/timeline/queryTimelineAgents.js";
import { queryTimelineEvents } from "../persistence/timeline/queryTimelineEvents.js";
import { queryAgentTreeUsage as queryPersistedAgentTreeUsage } from "../persistence/session/queryAgentTreeUsage.js";
import { queryAgentTreeSessionIds } from "../persistence/session/queryAgentTreeSessionIds.js";
import { queryLiveAgentTreeUsage } from "./queryLiveAgentTreeUsage.js";
import { buildTimeline } from "../timeline/index.js";
import { queryTerminalRunEvent } from "../persistence/session/queryTerminalRunEvent.js";
import { inTx } from "../persistence/inTx.js";
import { PresenceStore, resolvePresences } from "../presence/index.js";
import { SlotEntryStore } from "../slots/index.js";
import { AppletStore } from "../applets/index.js";
import { WorkletStore } from "../worklets/index.js";
import { querySlotScopeTargetExists } from "../persistence/slots/querySlotScopeTargetExists.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import type { TX } from "../persistence/Transaction.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { configureSessionRequest } from "./configureSessionRequest.js";
import {
    executeSessionWorkspaceTransfer,
    scheduleSessionWorkspaceTransfer,
} from "./transferSessionWorkspace.js";
import { HappyCloudService } from "../happy-cloud/index.js";
import { workspaceRunReadiness } from "./workspaceRunReadiness.js";
import { queryRigProfile } from "../persistence/profile/queryRigProfiles.js";
import { createWorkspaceReadyWaiters } from "./workspaceReadyWaiters.js";
import {
    deferSessionTransactionCommit,
    isSessionTransactionPostCommitError,
    runSessionTransaction,
    sessionTransactionScope,
} from "./SessionTransactionContext.js";

const RESTORED_SESSION_EVENT_LIMIT = 4_096;
const MAX_SCHEDULE_TIMER_DELAY_MS = 2_147_000_000;
/**
 * How often the daemon looks for Unsorted chats that have run out of time. A chat has a whole day
 * to file itself, so looking once an hour puts it away close enough to the moment it expires.
 */
const UNSORTED_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/** How many Unsorted chats one sweep may put away, so a long backlog is worked through in batches. */
const UNSORTED_SWEEP_LIMIT = 100;
/** One pass drains a useful backlog without monopolizing the synchronous database. */
const UNSORTED_SWEEP_MAX_SESSIONS = 1_000;
const UNSORTED_SWEEP_MAX_MS = 250;
const TOOL_RESULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const TOOL_RESULT_SWEEP_BATCH_LIMIT = 10;
const TOOL_RESULT_SWEEP_MAX_SCANNED_MESSAGES = 100;
const TOOL_RESULT_SWEEP_MAX_MS = 250;

export interface PersistentSessionStoreOptions {
    createRuntime?: InMemorySessionOptions["createRuntime"];
    databasePath: string;
    defaultDocker?: DockerExecutionConfig;
    localInstanceId?: string;
    durableGlobalEventQueue?: boolean;
    mcpToolProvider?: McpToolProvider;
    modelCatalog?: ModelCatalog;
    resolveModelCatalog?: (ownerInstanceId: string) => ModelCatalog;
    now?: () => number;
    onSessionAccess?: (session: InMemorySession) => void;
    onSessionEvent?: (
        event: SessionEvent,
        session: InMemorySession | undefined,
    ) => void | Promise<void>;
    onWorkspaceBranchError?: (error: unknown, projectId: string, workspaceId: string) => void;
    onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
    presence?: PresenceStore;
    gitCredentialBroker?: ProjectRepositoryOptions["gitCredentialBroker"];
    projectGit?: GitCommandRunner;
    projectClone?: ProjectRepositoryOptions["cloneRemote"];
    taskDrain?: TaskDrain;
    toolResultRetentionMs?: number;
    secrets?: readonly EnvironmentSecretRegistration[];
    homeDirectory?: string;
    stateDirectory?: string;
    workspacesDirectory?: string;
    workspaceFeatures?: WorkspaceFeatures;
}

export class PersistentSessionStore implements SessionStore, InMemorySessionPersistence {
    #agentManager: AgentSessionManager;
    #createRuntime: InMemorySessionOptions["createRuntime"];
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #createPresenceEventId = createEventIdFactory();
    readonly #createSharingResetEventId = createEventIdFactory();
    readonly #createTerminalEventId = createEventIdFactory();
    #database: SessionDatabase;
    readonly dataEpoch: string;
    readonly dataSchemaVersion: number;
    #modelCatalog: ModelCatalog;
    readonly localInstanceId: string;
    readonly #resolveModelCatalog: (ownerInstanceId: string) => ModelCatalog;
    #mcpToolProvider: McpToolProvider | undefined;
    #now: () => number;
    #onSessionAccess: ((session: InMemorySession) => void) | undefined;
    #onSessionEvent:
        | ((event: SessionEvent, session: InMemorySession | undefined) => void)
        | undefined;
    #onWorkspaceCleanupError:
        | ((error: unknown, projectId: string, workspaceId: string) => void)
        | undefined;
    #globalEventQueue: GlobalEventQueue;
    #precommittedGlobalEvents = new Map<EventId, GlobalEventQueueEntry | null>();
    #folders: FolderRepository;
    #documents: DocumentRepository;
    #projects: ProjectRepository;
    #workspaceReadyWaiters!: ReturnType<typeof createWorkspaceReadyWaiters>;
    #secrets: SecretRegistry;
    readonly #workspaceFeatures: WorkspaceFeatures;
    #sessions = new Map<string, WeakRef<InMemorySession>>();
    readonly #workspaceTransferReservations = new Map<string, string>();
    #scheduledMessageTimer: ReturnType<typeof setTimeout> | undefined;
    #unsortedSweepTimer: ReturnType<typeof setInterval> | undefined;
    #unsortedSweepFollowup: ReturnType<typeof setImmediate> | undefined;
    readonly #toolResultRetentionMs: number | undefined;
    #toolResultSweepCursor: SessionToolResultPruneCursor | undefined;
    #toolResultSweepTimer: ReturnType<typeof setInterval> | undefined;
    #toolResultSweepFollowup: ReturnType<typeof setImmediate> | undefined;
    #sessionFinalizer = new FinalizationRegistry<{
        id: string;
        reference: WeakRef<InMemorySession>;
    }>(({ id, reference }) => {
        if (this.#sessions.get(id) === reference) this.#sessions.delete(id);
    });
    #taskDrain: TaskDrain | undefined;
    readonly liveEvents = new LiveGlobalEventQueue();
    readonly happyCloud: HappyCloudService;
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    readonly slots: SlotEntryStore;
    readonly applets: AppletStore;
    readonly worklets: WorkletStore;

    static async open(options: PersistentSessionStoreOptions): Promise<PersistentSessionStore> {
        if (options.databasePath !== ":memory:") {
            await mkdir(dirname(options.databasePath), { mode: 0o700, recursive: true });
        }
        const opened = await openSessionDatabase(options.databasePath);
        try {
            const localInstanceId = validOwnerInstanceId(options.localInstanceId ?? createId());
            await migrateSessionDatabase(opened.database, { localInstanceId });
            const dataEpoch = await queryRigDataEpoch(opened.database);
            const dataSchemaVersion = await querySessionDatabaseVersion(opened.database);
            if (dataSchemaVersion !== CURRENT_SESSION_DATABASE_VERSION) {
                throw new Error(
                    "The persistent Rig store did not reach the current schema version.",
                );
            }
            if (options.databasePath !== ":memory:") {
                await chmod(options.databasePath, 0o600);
            }
            const store = new PersistentSessionStore(
                options,
                opened,
                localInstanceId,
                dataEpoch,
                dataSchemaVersion,
            );
            await store.#initialize(options);
            return store;
        } catch (error) {
            await opened.database.close();
            throw error;
        }
    }

    private constructor(
        options: PersistentSessionStoreOptions,
        opened: OpenSessionDatabase,
        localInstanceId: string,
        dataEpoch: string,
        dataSchemaVersion: number,
    ) {
        this.localInstanceId = localInstanceId;
        this.#resolveModelCatalog =
            options.resolveModelCatalog ?? (() => options.modelCatalog ?? createModelCatalog());
        this.#database = opened.database;
        this.dataEpoch = dataEpoch;
        this.dataSchemaVersion = dataSchemaVersion;
        this.presence = options.presence ?? new PresenceStore({ presences: resolvePresences() });
        this.presence.onChange((state) => {
            for (const session of this.#cachedSessions()) session.presenceChanged(state);
            const event = {
                createdAt: this.#now(),
                data: { presence: state },
                id: this.#createPresenceEventId(),
                type: "presence_changed" as const,
            };
            this.#globalEventQueue.publishLive(event);
            this.liveEvents.publish(event);
        });
        this.#secrets = new SecretRegistry();
        this.#modelCatalog = this.#resolveModelCatalog(this.localInstanceId);
        this.#createRuntime = options.createRuntime;
        this.#defaultDocker = options.defaultDocker;
        this.#mcpToolProvider = options.mcpToolProvider;
        this.#now = options.now ?? Date.now;
        this.#onSessionAccess = options.onSessionAccess;
        this.#onSessionEvent = options.onSessionEvent;
        this.#onWorkspaceCleanupError = options.onWorkspaceCleanupError;
        this.#taskDrain = options.taskDrain;
        this.#toolResultRetentionMs = options.toolResultRetentionMs;
        this.#workspaceFeatures = options.workspaceFeatures ?? DEFAULT_WORKSPACE_FEATURES;
        this.#globalEventQueue = new InMemoryGlobalEventQueue();
        this.happyCloud = new HappyCloudService({
            now: this.#now,
            persistence: this,
            publish: (event) => this.#publishGlobalEvent(event),
        });
        this.applets = new AppletStore({
            now: this.#now,
            publish: (event) => this.#publishGlobalEvent(event),
            tx: () => this.#tx(),
        });
        this.worklets = new WorkletStore({ tx: () => this.#tx() });
        this.slots = new SlotEntryStore({
            now: this.#now,
            publish: (event) => this.#publishGlobalEvent(event),
            sessionExists: (tx, sessionId) => querySlotScopeTargetExists(tx, "session", sessionId),
            tx: () => this.#tx(),
        });
        this.#projects = new ProjectRepository({
            afterTransactionCommit: (callback) => this.#afterTransactionCommit(callback),
            ...(options.projectClone === undefined ? {} : { cloneRemote: options.projectClone }),
            database: this.#database,
            ...(options.gitCredentialBroker === undefined
                ? {}
                : { gitCredentialBroker: options.gitCredentialBroker }),
            localInstanceId: this.localInstanceId,
            ...(options.projectGit === undefined ? {} : { git: options.projectGit }),
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (event) => this.#projectEvent(event),
            resolveGitSecret: (kind) => this.#secrets.resolveSpecial(kind).GH_TOKEN,
            resolveProfile: async (profileId) => await queryRigProfile(this.#tx(), profileId),
            ...(options.onWorkspaceBranchError === undefined
                ? {}
                : { onWorkspaceBranchError: options.onWorkspaceBranchError }),
            ...(options.onWorkspaceCleanupError === undefined
                ? {}
                : { onWorkspaceCleanupError: options.onWorkspaceCleanupError }),
            ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
            transaction: (body) => this.#transaction(body),
            ...(options.stateDirectory !== undefined
                ? { stateDirectory: options.stateDirectory }
                : options.databasePath === ":memory:"
                  ? {}
                  : { stateDirectory: dirname(options.databasePath) }),
            ...(options.workspacesDirectory === undefined
                ? {}
                : { workspacesDirectory: options.workspacesDirectory }),
        });
        this.#folders = new FolderRepository({
            database: this.#database,
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            now: this.#now,
            onEvent: (event) => this.#publishGlobalEvent(event),
            onFolderContextChanged: async (folderIds) => {
                await this.#afterTransactionCommit(() => {
                    const affected = new Set(folderIds);
                    for (const session of this.#cachedSessions()) {
                        if (session.belongsToFolderContext(affected))
                            session.folderContextChanged();
                    }
                });
            },
            onSessionsArchived: async (sessionIds) => {
                await this.#afterTransactionCommit(async () => {
                    await Promise.all(
                        sessionIds.map(async (sessionId) => {
                            await (await this.get(sessionId))?.recordFolderArchived();
                        }),
                    );
                });
            },
            transaction: (body) => this.#transaction(body),
        });
        this.#documents = new DocumentRepository({
            database: this.#database,
            now: this.#now,
            onEvent: (event) => this.#publishGlobalEvent(event),
            transaction: (body) => this.#transaction(body),
        });
        this.#workspaceReadyWaiters = createWorkspaceReadyWaiters((projectId, workspaceId) =>
            this.#projects.getWorkspace(projectId, workspaceId),
        );
        this.remoteTerminals = new ProjectRemoteTerminalStore({
            onChange: (scope, terminals) => {
                const event = {
                    createdAt: this.#now(),
                    data: { terminals },
                    id: this.#createTerminalEventId(),
                    projectId: scope.projectId,
                    type: "remote_terminals_changed" as const,
                    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
                };
                this.#globalEventQueue.publishLive(event);
                this.liveEvents.publish(event);
            },
            resolveContext: (scope) => this.#remoteTerminalContext(scope),
        });
        this.#agentManager = new AgentSessionManager({
            localInstanceId: this.localInstanceId,
            repository: {
                archiveOwnedWorkspace: async (ownerSessionId, projectId, workspaceId) =>
                    (await this.#projects.getOwnedWorkspace(
                        ownerSessionId,
                        projectId,
                        workspaceId,
                    )) === undefined
                        ? undefined
                        : this.#archiveWorkspace(projectId, workspaceId),
                createOwnedWorkspace: async (ownerSessionId, projectId, request) => {
                    const owner = (await this.get(ownerSessionId))?.snapshot();
                    const createdBy =
                        owner?.profileId === undefined
                            ? undefined
                            : {
                                  instanceId: owner.ownerInstanceId,
                                  profileId: owner.profileId,
                              };
                    return this.#projects.createWorkspace(
                        projectId,
                        {
                            ...request,
                            ...(createdBy === undefined ? {} : { identity: createdBy.profileId }),
                        },
                        ownerSessionId,
                        createdBy === undefined ? {} : { createdBy },
                    );
                },
                configureWorkspaceRequest: async (request) =>
                    await this.#configureWorkspaceRequest(request),
                createSubagent: async (request, metadata, contextMessages) =>
                    await this.#createSession(request, metadata, contextMessages),
                createDelegatedSession: async (request, metadata, id) =>
                    await this.#createSession(request, metadata, undefined, id),
                findByAgentId: (agentId) =>
                    this.#cachedSessions().find(
                        (session) => session.agentIdentity().agentId === agentId,
                    ),
                get: (sessionId) => this.#cachedSession(sessionId),
                listByRoot: (rootSessionId) =>
                    this.#cachedSessions().filter(
                        (session) =>
                            session.isSubagent() &&
                            session.agentMetadata().rootSessionId === rootSessionId,
                    ),
                listProjects: async () => await this.#projects.listProjects(),
                registerProject: (path) => this.#projects.registerProject({ path }),
                listProjectWorkspaces: async (projectId) =>
                    await this.#projects.listWorkspaces(projectId),
                listProjectSessions: async (target) =>
                    await queryWorkspaceSessions(this.#tx(), target),
                queryAgentTreeUsage: (sessionId) =>
                    queryLiveAgentTreeUsage(this.#cachedSessions(), sessionId),
                ownedWorkspace: (ownerSessionId, projectId, workspaceId) =>
                    this.#projects.getOwnedWorkspace(ownerSessionId, projectId, workspaceId),
                workspace: (projectId, workspaceId) =>
                    this.#projects.getWorkspace(projectId, workspaceId),
                waitForWorkspaceReady: (projectId, workspaceId, signal) =>
                    this.#workspaceReadyWaiters.wait(projectId, workspaceId, signal),
                completeScheduledSessionTransfer: async (sessionId, targetWorkspaceId) => {
                    const result = await this.#executeSessionTransfer(
                        sessionId,
                        targetWorkspaceId,
                        true,
                    );
                    if (result === undefined) {
                        throw new Error("The session is no longer available.");
                    }
                },
                scheduleSessionTransfer: async (sessionId, targetWorkspaceId) => {
                    const session = this.#cachedSession(sessionId);
                    if (session === undefined) {
                        throw new Error("The session is no longer available.");
                    }
                    return scheduleSessionWorkspaceTransfer({
                        hasAttachedSessions: async (workspaceId) =>
                            await queryWorkspaceHasAttachedSessions(this.#tx(), workspaceId),
                        projects: this.#projects,
                        releaseTarget: (workspaceId, ownerSessionId) =>
                            this.#releaseWorkspaceTransferTarget(workspaceId, ownerSessionId),
                        reserveTarget: (workspaceId, ownerSessionId) =>
                            this.#reserveWorkspaceTransferTarget(workspaceId, ownerSessionId),
                        session,
                        targetWorkspaceId,
                    });
                },
            },
            ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
        });
    }

    async #initialize(options: PersistentSessionStoreOptions): Promise<void> {
        await this.#loadSecretRegistrations();
        for (const secret of options.secrets ?? []) await this.registerSecret(secret);
        if (options.durableGlobalEventQueue === true) {
            this.#globalEventQueue = await PersistentGlobalEventQueue.open(this.#database);
        }
        await this.#repairInterruptedTitleGenerations();
        await this.repairInterruptedSessions("crash");
        this.#armScheduledMessageTimer();
        this.#armUnsortedSweepTimer();
        if (this.#toolResultRetentionMs !== undefined) this.#armToolResultSweepTimer();
        const recover = () => this.#recoverProjectWorkspaces();
        const recovery = this.#taskDrain?.run(recover) ?? recover();
        void recovery.catch((error: unknown) => {
            if (this.#database.closed) return;
            if (isDatabaseFailure(error)) throw error;
        });
    }

    async changeModel(
        sessionId: string,
        request: ChangeModelRequest,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        await session.changeModel(request);
        return session;
    }

    async attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = persistentCodeScope(session.snapshot().scope).projectId;
            await projectSecretAttach(this.#tx(), projectId, secretId);
            this.#secrets.reference(secretId);
            for (const candidate of this.#cachedSessions()) {
                const candidateScope = candidate.snapshot().scope;
                if (
                    (candidateScope.kind === "project" || candidateScope.kind === "workspace") &&
                    candidateScope.projectId === projectId
                ) {
                    await candidate.attachSecret(secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            await session.attachSecret(secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    async changeEffort(
        sessionId: string,
        request: ChangeEffortRequest,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        await session.changeEffort(request);
        return session;
    }

    async changeServiceTier(
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(sessionId);
        if (session === undefined) return undefined;
        await session.changeServiceTier(request);
        return session;
    }

    async clearMessages(sessionId: string): Promise<void> {
        await sessionClearMessages(this.#tx(), sessionId);
    }

    async deleteMessagesFrom(sessionId: string, position: number): Promise<void> {
        await sessionRewind(this.#tx(), sessionId, position);
    }

    async close(): Promise<void> {
        if (this.#scheduledMessageTimer !== undefined) {
            clearTimeout(this.#scheduledMessageTimer);
            this.#scheduledMessageTimer = undefined;
        }
        if (this.#unsortedSweepTimer !== undefined) {
            clearInterval(this.#unsortedSweepTimer);
            this.#unsortedSweepTimer = undefined;
        }
        if (this.#unsortedSweepFollowup !== undefined) {
            clearImmediate(this.#unsortedSweepFollowup);
            this.#unsortedSweepFollowup = undefined;
        }
        if (this.#toolResultSweepTimer !== undefined) {
            clearInterval(this.#toolResultSweepTimer);
            this.#toolResultSweepTimer = undefined;
        }
        if (this.#toolResultSweepFollowup !== undefined) {
            clearImmediate(this.#toolResultSweepFollowup);
            this.#toolResultSweepFollowup = undefined;
        }
        await this.remoteTerminals.close();
        this.#workspaceReadyWaiters.close();
        await this.#projects.close();
        this.liveEvents.close();
        this.#globalEventQueue.deactivate();
        await this.#database.close();
    }

    async #configureWorkspaceRequest(request: CreateSessionRequest): Promise<CreateSessionRequest> {
        const { docker: _docker, local: _local, ...base } = request;
        return await configureSessionRequest(
            base,
            this.#defaultDocker,
            async () => await this.#projects.queryProjectSettings(request.cwd),
        );
    }

    async create(
        request: CreateSessionRequest,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
        this.#assertAcceptingMutations();
        return await this.#createSession(request, undefined, undefined, undefined, options);
    }

    /**
     * Creates a session under an identity its caller chose.
     *
     * The identity is only checked for shape where a client supplies it, at the
     * protocol boundary. Rig's own integrations derive identities of their own,
     * and they reach this method directly.
     */
    async createWithId(
        id: string,
        request: CreateSessionRequest,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
        this.#assertAcceptingMutations();
        const existing = await this.get(id);
        if (existing !== undefined) return await retriedSession(existing, request);
        return await this.#createSession(request, undefined, undefined, id, options);
    }

    async detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        const session = await this.get(sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = persistentCodeScope(session.snapshot().scope).projectId;
            await projectSecretDetach(this.#tx(), projectId, secretId);
            for (const candidate of this.#cachedSessions()) {
                const candidateScope = candidate.snapshot().scope;
                if (
                    (candidateScope.kind === "project" || candidateScope.kind === "workspace") &&
                    candidateScope.projectId === projectId
                ) {
                    await candidate.detachSecret(secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            await session.detachSecret(secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    async fork(sessionId: string, targetSessionId?: string): Promise<InMemorySession | undefined> {
        this.#assertAcceptingMutations();
        if (targetSessionId !== undefined) {
            const existing = await this.get(targetSessionId);
            if (existing !== undefined) return existing;
        }
        const source = await this.get(sessionId);
        if (source === undefined) return undefined;
        const sourceSnapshot = source.snapshot();
        const folderPath =
            sourceSnapshot.scope.kind === "folder"
                ? await this.#folders.activeFolderStoragePath(sourceSnapshot.scope.folderId)
                : undefined;
        const state = source.createForkState();
        const forkState =
            folderPath === undefined
                ? state
                : (() => {
                      const { docker: _docker, ...rest } = state;
                      return { ...rest, cwd: folderPath };
                  })();
        const sourceRequest = source.requestForSubagent();
        const forkRequest =
            folderPath === undefined
                ? sourceRequest
                : (() => {
                      const { docker: _docker, ...rest } = sourceRequest;
                      return { ...rest, cwd: folderPath };
                  })();
        if (sourceSnapshot.scope.kind === "workspace") {
            this.#assertWorkspaceAcceptingSessions(sourceSnapshot.scope.workspaceId);
        }
        if (sourceSnapshot.scope.kind === "workspace") {
            const workspace = await this.#projects.getWorkspace(
                sourceSnapshot.scope.projectId,
                sourceSnapshot.scope.workspaceId,
            );
            if (
                workspace === undefined ||
                (
                    await workspaceRunReadiness(this.#projects, {
                        cwd: sourceSnapshot.cwd,
                        projectId: sourceSnapshot.scope.projectId,
                        workspaceId: sourceSnapshot.scope.workspaceId,
                    })
                ).state !== "ready"
            ) {
                throw new Error("A session in an unavailable workspace cannot be forked.");
            }
        }
        let session!: InMemorySession;
        await this.#transaction(async () => {
            session = await InMemorySession.open({
                presence: this.presence,
                agentManager: this.#agentManager,
                workspaceFeatures: this.#workspaceFeatures,
                workspaceRunReadiness: (target) => workspaceRunReadiness(this.#projects, target),
                createEventId: createEventIdFactory(),
                ...(this.#createRuntime === undefined
                    ? {}
                    : { createRuntime: this.#createRuntime }),
                deferEventNotification: (notify) => this.#afterTransactionCommit(notify),
                emitCreatedEvent: false,
                ...(targetSessionId === undefined ? {} : { id: targetSessionId }),
                modelCatalog: this.#modelCatalogFor(state.ownerInstanceId),
                now: this.#now,
                onInitialTitle: async (metadata) => await this.#inheritWorkspaceName(metadata),
                ...(this.#mcpToolProvider !== undefined
                    ? { mcpToolProvider: this.#mcpToolProvider }
                    : {}),
                onAppendEvent: async (event) => await this.#appendEvent(event),
                persistence: this,
                folders: this.#folders,
                slotStores: { entries: this.slots, applets: this.applets },
                request: forkRequest,
                ...(sourceSnapshot.scope.kind === "project" ||
                sourceSnapshot.scope.kind === "workspace"
                    ? {
                          projectSecretIds: await this.#projectSecrets(
                              sourceSnapshot.scope.projectId,
                          ),
                      }
                    : {}),
                ownerInstanceId: state.ownerInstanceId,
                ...(state.profileId === undefined ? {} : { profileId: state.profileId }),
                resolveGitAuthentication: async (projectId, creator) =>
                    await this.#projects.gitAuthentication(projectId, creator),
                resolveProfile: async (profileId) => await queryRigProfile(this.#tx(), profileId),
                secretRegistry: this.#secrets,
                restore: {
                    ...forkState,
                    ...(targetSessionId === undefined
                        ? {}
                        : {
                              agent: { ...forkState.agent, rootSessionId: targetSessionId },
                              id: targetSessionId,
                          }),
                    orderKey: await this.#newLastSessionOrderKey(sourceSnapshot.scope),
                },
                scope: sourceSnapshot.scope,
                ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
            });
            for (const message of forkState.messages) {
                await this.upsertMessage(session.id, message);
            }
            await session.emitCreatedEvent();
        });
        this.#cacheSession(session);
        return session;
    }

    async #createSession(
        request: CreateSessionRequest,
        metadata?: SessionAgentMetadata,
        contextMessages?: readonly Message[],
        id?: string,
        options: SessionCreationOptions = {},
    ): Promise<InMemorySession> {
        this.#assertAcceptingMutations();
        const sessionId = id ?? createId();
        let session!: InMemorySession;
        let newUnsortedStorage: { created: boolean; path: string } | undefined;
        try {
            await this.#transaction(async () => {
                const inherited =
                    metadata?.parentSessionId === undefined
                        ? undefined
                        : (await this.get(metadata.parentSessionId))?.snapshot();
                if (metadata?.parentSessionId !== undefined && inherited === undefined) {
                    throw new Error("The parent session was not found.");
                }
                if (inherited?.status === "archived") {
                    throw new Error("An archived session cannot create a subagent.");
                }
                const ownerInstanceId =
                    inherited?.ownerInstanceId ??
                    (options.ownerInstanceId === undefined
                        ? this.localInstanceId
                        : validOwnerInstanceId(options.ownerInstanceId));
                const profileId = inherited?.profileId ?? options.profileId ?? request.identity;
                if (profileId !== undefined) {
                    const profile = await queryRigProfile(this.#tx(), profileId);
                    if (profile?.parentInstanceId !== ownerInstanceId) {
                        throw new Error("The session profile is not owned by the session's Rig.");
                    }
                }
                const inheritedWorkspace =
                    inherited?.scope.kind === "workspace"
                        ? await this.#projects.getWorkspace(
                              inherited.scope.projectId,
                              inherited.scope.workspaceId,
                          )
                        : undefined;
                if (
                    inherited?.scope.kind === "workspace" &&
                    (inheritedWorkspace === undefined ||
                        (
                            await workspaceRunReadiness(this.#projects, {
                                cwd: inherited.cwd,
                                projectId: inherited.scope.projectId,
                                workspaceId: inherited.scope.workspaceId,
                            })
                        ).state !== "ready")
                ) {
                    throw new Error("The parent session workspace is not ready and available.");
                }
                const resolved = await (async () => {
                    if (inherited === undefined) {
                        if (request.scope?.kind === "folder") {
                            return {
                                request: {
                                    ...request,
                                    cwd: await this.#folders.activeFolderStoragePath(
                                        request.scope.folderId,
                                    ),
                                },
                                scope: request.scope,
                            };
                        }
                        if (request.scope?.kind === "unsorted") {
                            newUnsortedStorage =
                                this.#folders.createUnsortedSessionDirectory(sessionId);
                            return {
                                request: {
                                    ...request,
                                    cwd: newUnsortedStorage.path,
                                },
                                scope: request.scope,
                            };
                        }
                        if (request.workspaceId !== undefined) {
                            const ownership = await this.#projects.resolveSessionOwnership(
                                request.cwd,
                                request.workspaceId,
                                request.projectId,
                            );
                            return {
                                ownership,
                                request,
                                scope: {
                                    kind: "workspace" as const,
                                    projectId: ownership.project.id,
                                    workspaceId: ownership.workspace?.id ?? request.workspaceId,
                                },
                            };
                        }
                        const ownership = await this.#projects.resolve(
                            request.cwd,
                            undefined,
                            request.projectId,
                        );
                        return {
                            ownership,
                            request,
                            scope:
                                ownership.workspace === undefined
                                    ? { kind: "project" as const, projectId: ownership.project.id }
                                    : {
                                          kind: "workspace" as const,
                                          projectId: ownership.project.id,
                                          workspaceId: ownership.workspace.id,
                                      },
                        };
                    }
                    if (
                        request.workspaceId !== undefined &&
                        (inherited.scope.kind !== "workspace" ||
                            request.workspaceId !== inherited.scope.workspaceId)
                    ) {
                        const inheritedCode = persistentCodeScope(inherited.scope);
                        const ownership = await this.#projects.resolve(
                            request.cwd,
                            request.workspaceId,
                            inheritedCode.projectId,
                        );
                        return {
                            ownership,
                            request,
                            scope: {
                                kind: "workspace" as const,
                                projectId: ownership.project.id,
                                workspaceId: ownership.workspace?.id ?? request.workspaceId,
                            },
                        };
                    }
                    if (inherited.scope.kind === "folder") {
                        const { docker: _docker, local: _local, ...inheritedRequest } = request;
                        return {
                            request: {
                                ...inheritedRequest,
                                cwd: await this.#folders.activeFolderStoragePath(
                                    inherited.scope.folderId,
                                ),
                            },
                            scope: inherited.scope,
                        };
                    }
                    return {
                        request: { ...request, cwd: inherited.cwd },
                        scope: inherited.scope,
                    };
                })();
                if (resolved.scope.kind === "workspace") {
                    this.#assertWorkspaceAcceptingSessions(resolved.scope.workspaceId);
                }
                const projectId =
                    resolved.scope.kind === "project" || resolved.scope.kind === "workspace"
                        ? resolved.scope.projectId
                        : undefined;
                const orderKey =
                    metadata?.type === "subagent"
                        ? ""
                        : await this.#newLastSessionOrderKey(resolved.scope);
                session = await InMemorySession.open({
                    presence: this.presence,
                    agentManager: this.#agentManager,
                    workspaceFeatures: this.#workspaceFeatures,
                    workspaceRunReadiness: (target) =>
                        workspaceRunReadiness(this.#projects, target),
                    createEventId: createEventIdFactory(),
                    ...(this.#createRuntime === undefined
                        ? {}
                        : { createRuntime: this.#createRuntime }),
                    deferEventNotification: (notify) => this.#afterTransactionCommit(notify),
                    emitCreatedEvent: false,
                    modelCatalog: this.#modelCatalogFor(ownerInstanceId),
                    now: this.#now,
                    onInitialTitle: async (metadata) => await this.#inheritWorkspaceName(metadata),
                    ...(this.#mcpToolProvider !== undefined
                        ? { mcpToolProvider: this.#mcpToolProvider }
                        : {}),
                    ...(metadata !== undefined ? { metadata } : {}),
                    ...(contextMessages !== undefined
                        ? { initialContextMessages: contextMessages }
                        : {}),
                    id: sessionId,
                    onAppendEvent: async (event) => await this.#appendEvent(event),
                    orderKey,
                    ownerInstanceId,
                    ...(profileId === undefined ? {} : { profileId }),
                    resolveGitAuthentication: async (candidateProjectId, creator) =>
                        await this.#projects.gitAuthentication(candidateProjectId, creator),
                    resolveProfile: async (candidateProfileId) =>
                        await queryRigProfile(this.#tx(), candidateProfileId),
                    persistence: this,
                    folders: this.#folders,
                    slotStores: { entries: this.slots, applets: this.applets },
                    ...(projectId === undefined
                        ? {}
                        : { projectSecretIds: await this.#projectSecrets(projectId) }),
                    request: resolved.request,
                    scope: resolved.scope,
                    ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
                    secretRegistry: this.#secrets,
                });
                await session.emitCreatedEvent();
            });
        } catch (error) {
            if (newUnsortedStorage?.created === true) {
                this.#folders.removeNewUnsortedSessionDirectory(sessionId, newUnsortedStorage.path);
            }
            throw error;
        }
        this.#cacheSession(session);
        return session;
    }

    async deleteQueuedRun(sessionId: string, runId: string): Promise<void> {
        await sessionDeleteQueuedRun(this.#tx(), sessionId, runId);
    }

    async acceptQueuedRun(
        input: Parameters<NonNullable<InMemorySessionPersistence["acceptQueuedRun"]>>[0],
    ): Promise<void> {
        let globalEntry: GlobalEventQueueEntry | undefined;
        await this.#transaction(async (tx) => {
            await sessionAcceptQueuedRun(tx, {
                ...input,
                now: input.submittedAt,
                sessionId: input.event.sessionId,
            });
            if (this.#globalEventQueue.durable) {
                globalEntry = await this.#globalEventQueue.append(input.event, tx);
            }
        });
        this.#precommittedGlobalEvents.set(input.event.id, globalEntry ?? null);
    }

    async failQueuedRun(
        input: Parameters<NonNullable<InMemorySessionPersistence["failQueuedRun"]>>[0],
    ): Promise<void> {
        let globalEntry: GlobalEventQueueEntry | undefined;
        await this.#transaction(async (tx) => {
            await sessionFailQueuedRun(tx, {
                ...input,
                now: this.#now(),
                sessionId: input.event.sessionId,
            });
            if (this.#globalEventQueue.durable) {
                globalEntry = await this.#globalEventQueue.append(input.event, tx);
            }
        });
        this.#precommittedGlobalEvents.set(input.event.id, globalEntry ?? null);
    }

    async get(sessionId: string): Promise<InMemorySession | undefined> {
        const existingReference = this.#sessions.get(sessionId);
        const existing = existingReference?.deref();
        if (existing !== undefined) {
            await this.#loadAgentTree(existing);
            await this.#notifySessionAccess(existing);
            return existing;
        }
        if (existingReference !== undefined) this.#sessions.delete(sessionId);

        const session = await this.#loadSession(sessionId);
        if (session !== undefined) {
            this.#cacheSession(session);
            await this.#loadAgentTree(session);
            await this.#notifySessionAccess(session);
        }
        return session;
    }

    async attachment(sessionId: string, attachmentId: string) {
        const session = await this.get(sessionId);
        return (
            session?.attachment(attachmentId) ??
            (await querySessionAttachment(this.#tx(), sessionId, attachmentId))
        );
    }

    async findByAgentId(agentId: string): Promise<InMemorySession | undefined> {
        const sessionId = await querySessionIdByAgentId(this.#tx(), agentId);
        return sessionId === undefined ? undefined : await this.get(sessionId);
    }

    get globalEventQueue(): GlobalEventQueue {
        return this.#globalEventQueue;
    }

    async setDurableGlobalEventQueue(enabled: boolean): Promise<GlobalEventQueue> {
        if (this.#globalEventQueue.durable === enabled) return this.#globalEventQueue;
        this.#globalEventQueue.deactivate();
        this.#globalEventQueue = enabled
            ? await PersistentGlobalEventQueue.open(this.#database, { resetStream: true })
            : new InMemoryGlobalEventQueue();
        return this.#globalEventQueue;
    }

    async insertQueuedRun(sessionId: string, run: PersistedQueuedRun): Promise<void> {
        await sessionSaveQueuedRun(this.#tx(), sessionId, run, this.#now());
    }

    async startQueuedRun(
        input: Parameters<NonNullable<InMemorySessionPersistence["startQueuedRun"]>>[0],
    ): Promise<readonly PersistedPendingContextMessage[]> {
        let globalEntry: GlobalEventQueueEntry | undefined;
        const drained = await this.#transaction(async (tx) => {
            const sessionId = input.event.sessionId;
            await sessionStartQueuedRun(tx, {
                activeSince: input.activeSince,
                event: input.event,
                now: this.#now(),
                runId: input.runId,
                sessionId,
            });
            if (this.#globalEventQueue.durable) {
                globalEntry = await this.#globalEventQueue.append(input.event, tx);
            }
            return await sessionDrainPendingContextMessages(tx, sessionId, input.regularMessageIds);
        });
        this.#precommittedGlobalEvents.set(input.event.id, globalEntry ?? null);
        return drained;
    }

    async insertPendingContextMessage(
        sessionId: string,
        pending: PersistedPendingContextMessage,
    ): Promise<void> {
        await sessionSavePendingContextMessage(this.#tx(), sessionId, pending, this.#now());
    }

    async drainPendingContextMessages(
        sessionId: string,
        messageIds?: readonly string[],
    ): Promise<readonly PersistedPendingContextMessage[]> {
        return await sessionDrainPendingContextMessages(this.#tx(), sessionId, messageIds);
    }

    async list(options: { limit?: number } = {}): Promise<readonly SessionSummary[]> {
        return await this.#listSessions(false, options);
    }

    async listActive(options: { limit?: number } = {}): Promise<readonly SessionSummary[]> {
        return await this.#listSessions(true, options);
    }

    async #listSessions(
        activeOnly: boolean,
        options: { limit?: number },
    ): Promise<readonly SessionSummary[]> {
        const summaries = await querySessionSummaries(this.#tx(), activeOnly, options);
        // A scheduled wait is live activity, so the stored row cannot carry it;
        // it is overlaid from the loaded sessions, the only ones that can wait.
        let waits: Map<string, SessionActivityWait> | undefined;
        for (const session of this.#cachedSessions()) {
            const wait = session.activity().wait;
            if (wait !== undefined) (waits ??= new Map()).set(session.id, wait);
        }
        const found = waits;
        if (found === undefined) return summaries;
        return summaries.map((summary) => {
            const wait = found.get(summary.id);
            return wait === undefined ? summary : { ...summary, wait };
        });
    }

    loadedSessions(): readonly InMemorySession[] {
        return this.#cachedSessions();
    }

    async listExternalToolCalls(
        options: { limit?: number; status?: ExternalToolCall["status"] } = {},
    ): Promise<readonly ExternalToolCall[]> {
        return await queryExternalToolCalls(this.#tx(), options);
    }

    async listDurableUserInputs(): Promise<readonly DurableUserInputCall[]> {
        return await queryDurableUserInputs(this.#tx());
    }

    async listSubagents(parentSessionId: string): Promise<readonly SubagentSummary[]> {
        return await querySubagentSummaries(this.#tx(), parentSessionId);
    }

    async queryAgentTreeUsage(sessionId: string) {
        return await queryPersistedAgentTreeUsage(this.#tx(), sessionId);
    }

    async timeline(request: GetTimelineRequest): Promise<readonly TimelineAgent[]> {
        // One consistent read: the agents and their events must describe the
        // same moment, or a run that ended between the two queries would be
        // charted as though it never stopped.
        return await inTx(this.#tx(), async (tx) => {
            const agents = await queryTimelineAgents(
                tx,
                request.scope,
                request.includeArchived ?? false,
            );
            const events = await queryTimelineEvents(
                tx,
                agents.map((agent) => agent.sessionId),
            );
            return buildTimeline(
                agents,
                events,
                request.since === undefined ? {} : { since: request.since },
            );
        });
    }

    async listSecrets(): Promise<readonly SecretSummary[]> {
        return this.#secrets.references();
    }

    async getProject(projectId: string): Promise<Project | undefined> {
        return await this.#projects.getProject(projectId);
    }

    async applyGitFacts(
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): Promise<void> {
        await this.#projects.applyGitFacts(target, facts);
    }

    /**
     * Reports a Git change to the live sessions running in that directory.
     *
     * Only cached sessions are told: a session nobody is holding has no attached
     * client to inform, and reads current Git state when it is next loaded.
     */
    async applyGitSnapshot(
        target: { projectId: string; workspaceId?: string },
        git: GitChangeSnapshot,
    ): Promise<void> {
        for (const session of this.#cachedSessions()) {
            const identity = session.projectIdentity();
            if (identity === undefined) continue;
            if (identity.projectId !== target.projectId) continue;
            if (identity.workspaceId !== target.workspaceId) continue;
            await session.recordGitState(git);
        }
    }

    async listFolders(): Promise<readonly Folder[]> {
        return await this.#folders.listFolders();
    }

    async folderCatalog() {
        return await this.#folders.folderCatalog();
    }

    async getFolder(folderId: string): Promise<Folder | undefined> {
        return await this.#folders.getFolder(folderId);
    }

    async getFolderItem(itemId: string): Promise<FolderItem | undefined> {
        return await this.#folders.getFolderItem(itemId);
    }

    async createFolderItem(
        folderId: string,
        request: CreateFolderItemRequest,
    ): Promise<FolderItem> {
        return await this.#folders.createFolderItem(folderId, request);
    }

    async moveFolderItem(
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion?: number,
    ): Promise<FolderItem | undefined> {
        return await this.#folders.moveFolderItem(itemId, request, expectedVersion);
    }

    async archiveFolderItem(
        itemId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<FolderItem | undefined> {
        return await this.#folders.archiveFolderItem(itemId, expectedVersion, mutationId);
    }

    async createFolder(request: CreateFolderRequest): Promise<Folder> {
        return await this.#folders.createFolder(request);
    }

    async updateFolder(
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        return await this.#folders.updateFolder(folderId, request, expectedVersion);
    }

    async moveFolder(
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined> {
        return await this.#folders.moveFolder(folderId, request, expectedVersion);
    }

    async archiveFolder(
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Folder | undefined> {
        return await this.#folders.archiveFolder(folderId, expectedVersion, mutationId);
    }

    async sharedFolderState(rootFolderId: string): Promise<SharedFolderState> {
        return await this.#folders.sharedFolderState(rootFolderId);
    }

    async sharedFolderGroup(folderId: string): Promise<string | undefined> {
        return await this.#folders.sharedFolderGroup(folderId);
    }

    async sharedFolderRoot(groupId: string): Promise<string | undefined> {
        return await this.#folders.sharedFolderRoot(groupId);
    }

    async assertFolderShareable(folderId: string): Promise<void> {
        await this.#folders.assertFolderShareable(folderId);
    }

    async markFolderShared(folderId: string, groupId: string): Promise<Folder> {
        return await this.#folders.markFolderShared(folderId, groupId);
    }

    async applySharedFolderState(groupId: string, state: SharedFolderState): Promise<Folder> {
        return await this.#folders.applySharedFolderState(groupId, state);
    }

    async resetSharingState(): Promise<void> {
        await this.#transaction(async (tx) => {
            const now = this.#now();
            const revision = await sharingStateReset(tx, now);
            if (revision === undefined) return;
            await this.#publishGlobalEvent({
                createdAt: now,
                data: { revision },
                id: this.#createSharingResetEventId(),
                type: "folders_changed",
            });
        });
    }

    async getDocument(documentId: string): Promise<Document | undefined> {
        return await this.#documents.getDocument(documentId);
    }

    async createDocument(
        request: CreateDocumentRequest,
        createdBy: DocumentCreatedBy,
    ): Promise<Document> {
        return await this.#documents.createDocument(request, createdBy);
    }

    async writeDocument(
        documentId: string,
        request: WriteDocumentRequest,
        expectedVersion: number,
    ): Promise<Document | undefined> {
        return await this.#documents.writeDocument(documentId, request, expectedVersion);
    }

    async documentUpdates(
        documentId: string,
        request: ListDocumentUpdatesRequest,
    ): Promise<DocumentUpdatePage | undefined> {
        return await this.#documents.documentUpdates(documentId, request);
    }

    async setSessionFolder(
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): Promise<InMemorySession | undefined> {
        this.#assertAcceptingMutations();
        const session = await this.get(sessionId);
        if (session === undefined) return undefined;
        await session.fileIntoFolder(folderId, afterId, mutationId);
        return session;
    }

    async sessionScopeMutationApplied(sessionId: string, mutationId: string): Promise<boolean> {
        return await this.#folders.sessionScopeMutationApplied(sessionId, mutationId);
    }

    async listProjects(): Promise<readonly Project[]> {
        return await this.#projects.listProjects();
    }

    registerProject(request: RegisterProjectRequest): Promise<Project> {
        return this.#projects.registerProject(request);
    }

    createRemoteProject(
        request: CreateRemoteProjectRequest,
        options?: { createdBy?: ProjectCreator; githubToken?: string; mutationId?: string },
    ): Promise<Project> {
        return this.#projects.createRemoteProject(request, {
            ...options,
            createdBy: options?.createdBy ?? {
                instanceId: this.localInstanceId,
                profileId: request.identity,
            },
        });
    }

    async getWorkspace(
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined> {
        return await this.#projects.getWorkspace(projectId, workspaceId);
    }

    async listWorkspaces(projectId?: string): Promise<readonly ProjectWorkspace[]> {
        return await this.#projects.listWorkspaces(projectId);
    }

    async renameProject(
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined> {
        return await this.#projects.renameProject(projectId, name, expectedVersion, mutationId);
    }

    async queryProjectSettings(cwd: string): Promise<ProjectSessionSettings | undefined> {
        return await this.#projects.queryProjectSettings(cwd);
    }

    async setProjectSettings(
        projectId: string,
        settings: ProjectSettingsUpdate,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined> {
        return await this.#projects.setProjectSettings(
            projectId,
            settings,
            expectedVersion,
            mutationId,
        );
    }

    async refreshProject(projectId: string): Promise<Project | undefined> {
        return await this.#projects.refreshProject(projectId);
    }

    async reorderProject(
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        return await this.#projects.reorderProject(projectId, request, expectedVersion);
    }

    async reorderSession(
        sessionId: string,
        request: ReorderRequest,
    ): Promise<InMemorySession | undefined> {
        this.#assertAcceptingMutations();
        const session = await this.get(sessionId);
        if (session === undefined) return undefined;
        if (session.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        const snapshot = session.snapshot();
        await this.#transaction(async () => {
            await session.setOrderKey(
                orderKeyAfter(
                    await this.#sessionOrderItems(snapshot.scope),
                    sessionId,
                    request.afterId,
                ),
            );
        });
        return session;
    }

    async reorderWorkspace(
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        return await this.#projects.reorderWorkspace(
            projectId,
            workspaceId,
            request,
            expectedVersion,
        );
    }

    async renameWorkspace(
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<ProjectWorkspace | undefined> {
        return await this.#projects.renameWorkspace(
            projectId,
            workspaceId,
            name,
            expectedVersion,
            mutationId,
        );
    }

    createWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
        options: { createdBy?: ProjectCreator; githubToken?: string } = {},
    ): Promise<ProjectWorkspace | undefined> {
        return this.#projects.createWorkspace(projectId, request, undefined, options);
    }

    async refreshSessionGitCredential(
        sessionId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<boolean> {
        const session = await this.get(sessionId);
        if (session === undefined) return false;
        const snapshot = session.snapshot();
        if (snapshot.projectId === undefined) return false;
        const project = await this.#projects.getProject(snapshot.projectId);
        if (
            project?.remoteSource?.kind !== "github" ||
            snapshot.ownerInstanceId !== creator.instanceId ||
            snapshot.profileId !== creator.profileId
        ) {
            return false;
        }
        if (
            project.createdBy?.instanceId === creator.instanceId &&
            project.createdBy.profileId === creator.profileId
        ) {
            await this.#projects.refreshGitCredential(snapshot.projectId, creator, githubToken);
        } else {
            await this.#projects.registerGitCredential(snapshot.projectId, creator, githubToken);
        }
        await session.refreshGitCommandSecret();
        return true;
    }

    archiveProject(projectId: string, expectedVersion?: number): Promise<Project | undefined> {
        const archive = () => this.#archiveProject(projectId, expectedVersion);
        return this.#taskDrain?.run(archive) ?? archive();
    }

    async unarchiveProject(projectId: string): Promise<Project | undefined> {
        return await this.#projects.unarchiveProject(projectId);
    }

    /*
     * Archiving a project hides the whole folder: its root chats are archived, and every managed
     * workspace is archived with the sessions and worktree directory it owns.
     */
    async #archiveProject(
        projectId: string,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        let project: Project | undefined;
        let archiving: string[] = [];
        const postCommitFailures: unknown[] = [];
        try {
            await this.#transaction(async () => {
                project = await this.#projects.archiveProject(projectId, expectedVersion);
                if (project === undefined) return;
                const rootSessionIds = await queryRootSessionIdsForProject(this.#tx(), projectId);
                for (const sessionId of rootSessionIds) {
                    await (await this.get(sessionId))?.setArchived(true);
                }
                for (const workspace of await this.#projects.listWorkspaces(projectId)) {
                    if (workspace.status === "archived" || workspace.status === "archiving") {
                        continue;
                    }
                    const begun = await this.#projects.beginWorkspaceArchive(
                        projectId,
                        workspace.id,
                    );
                    if (begun !== undefined && begun.status !== "archived") {
                        archiving.push(workspace.id);
                    }
                }
            });
        } catch (error) {
            if (!isSessionTransactionPostCommitError(error)) throw error;
            postCommitFailures.push(error);
        }
        if (project === undefined) {
            if (postCommitFailures.length > 0) throw postCommitFailures[0];
            return undefined;
        }
        // Every workspace is logically archived above; its sessions follow one transaction at a
        // time so no session teardown runs while the project archival holds the write lock.
        const workspaces: { cleanup: Promise<void>[]; workspaceId: string }[] = [];
        for (const workspaceId of archiving) {
            try {
                workspaces.push({
                    cleanup: await this.#archiveWorkspaceSessions(workspaceId),
                    workspaceId,
                });
            } catch (error) {
                if (!isSessionTransactionPostCommitError(error)) throw error;
                postCommitFailures.push(error);
                workspaces.push({ cleanup: [], workspaceId });
            }
        }
        // All logical state is committed before physical cleanup yields.
        const cleanup = await Promise.allSettled([
            this.remoteTerminals.closeProject(projectId),
            ...workspaces.map((workspace) =>
                this.#completeWorkspaceArchive(projectId, workspace.workspaceId, workspace.cleanup),
            ),
        ]);
        const failures = [
            ...postCommitFailures,
            ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                "Project archival committed, but its post-commit cleanup failed.",
            );
        }
        return await this.getProject(projectId);
    }

    archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        return this.#archiveWorkspace(projectId, workspaceId, expectedVersion);
    }

    async #archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        // The workspace becomes "archiving" in its own transaction, before any session is touched.
        // That decision is what makes the rest resumable: a daemon that dies partway through finds
        // the workspace still archiving on the next start and runs the remaining sessions.
        const workspace = await this.#transaction(() =>
            this.#projects.beginWorkspaceArchive(projectId, workspaceId, expectedVersion),
        );
        if (workspace === undefined || workspace.status === "archived") {
            return Promise.resolve(workspace);
        }
        const cleanup = await this.#archiveWorkspaceSessions(workspaceId);
        cleanup.push(this.remoteTerminals.closeWorkspace(projectId, workspaceId));
        const finish = () => this.#completeWorkspaceArchive(projectId, workspaceId, cleanup);
        const background = this.#taskDrain?.run(finish) ?? finish();
        void background.catch((error: unknown) => {
            // Residue left behind is worth a warning because a later attempt can still clear it.
            // A database that cannot answer is neither reportable nor retryable.
            if (isDatabaseFailure(error)) throw error;
            this.#onWorkspaceCleanupError?.(error, projectId, workspaceId);
        });
        // Logical archival is already durable. Physical cleanup must never hold
        // the request open or make the workspace visible again.
        return Promise.resolve(workspace);
    }

    /**
     * Archives all sessions in one database transaction and starts their teardown only after that
     * transaction commits. A failure in any queued-run/event write restores every session touched
     * by the transaction, so memory cannot get ahead of SQLite.
     */
    async #archiveWorkspaceSessions(workspaceId: string): Promise<Promise<void>[]> {
        // Sessions cannot join a workspace that is already archiving, so this list only shrinks.
        const pending = await this.#transaction(() =>
            queryUnarchivedSessionIdsForWorkspace(this.#tx(), workspaceId),
        );
        const touched: Array<{
            checkpoint: ReturnType<InMemorySession["captureMutationCheckpoint"]>;
            session: InMemorySession;
        }> = [];
        const teardowns: Array<() => Promise<void>> = [];
        try {
            await this.#transaction(async () => {
                for (const sessionId of pending) {
                    const session = await this.get(sessionId);
                    if (session === undefined) continue;
                    touched.push({
                        checkpoint: session.captureMutationCheckpoint(),
                        session,
                    });
                    const teardown = await session.archiveForWorkspace(workspaceId);
                    teardowns.push(teardown);
                }
            });
        } catch (error) {
            if (isSessionTransactionPostCommitError(error)) {
                const cleanup = await Promise.allSettled(teardowns.map((teardown) => teardown()));
                const failures = cleanup.flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : [],
                );
                if (failures.length > 0) {
                    throw new AggregateError(
                        [error, ...failures],
                        "Workspace archival committed, but its post-commit work failed.",
                    );
                }
            } else {
                for (const { checkpoint, session } of touched) {
                    session.restoreMutationCheckpoint(checkpoint);
                }
            }
            throw error;
        }
        return teardowns.map((teardown) => teardown());
    }

    async #completeWorkspaceArchive(
        projectId: string,
        workspaceId: string,
        cleanup: readonly Promise<void>[],
    ): Promise<ProjectWorkspace | undefined> {
        const results = await Promise.allSettled(cleanup);
        for (const result of results) {
            if (result.status === "rejected") {
                if (isDatabaseFailure(result.reason)) throw result.reason;
                this.#onWorkspaceCleanupError?.(result.reason, projectId, workspaceId);
            }
        }
        return await this.#projects.removeArchivedWorkspace(projectId, workspaceId);
    }

    setProjectAvatar(
        projectId: string,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        return this.#projects.setAvatar(projectId, "user", bytes, expectedVersion);
    }

    async clearProjectAvatar(projectId: string): Promise<Project | undefined> {
        return await this.#projects.clearAvatar(projectId);
    }

    getProjectAvatar(hash: string): Promise<ProjectAvatarAsset | undefined> {
        return this.#projects.avatarAsset(hash);
    }

    async registerSecret(request: RegisterSecretRequest): Promise<SecretSummary> {
        const candidate = new SecretRegistry([request]);
        await secretRegister(this.#tx(), request);
        this.#secrets.register(request);
        return candidate.reference(request.id);
    }

    async registerSpecialSecret(request: SpecialSecretRegistration): Promise<SecretSummary> {
        this.#secrets.register(request);
        await this.#projects.retryRemoteProjects(request.kind);
        return this.#secrets.reference(request.kind);
    }

    resolveSpecialSecret(kind: SpecialSecretKind): NodeJS.ProcessEnv {
        return this.#secrets.resolveSpecial(kind);
    }

    async unregisterSecret(secretId: string): Promise<boolean> {
        const secret = this.#secrets.references().find((candidate) => candidate.id === secretId);
        if (secret === undefined || secret.kind !== undefined) return false;
        await secretUnregister(this.#tx(), secretId);
        this.#secrets.unregister(secretId);
        for (const session of this.#cachedSessions()) {
            await session.detachSecret(secretId, { scope: "project" });
            await session.detachSecret(secretId, { scope: "session" });
        }
        return true;
    }

    async unregisterSpecialSecret(kind: SpecialSecretKind): Promise<boolean> {
        return this.#secrets.unregisterSpecial(kind);
    }

    async updateSecret(
        secretId: string,
        request: UpdateSecretRequest,
    ): Promise<SecretSummary | undefined> {
        const updated = this.#secrets.updatedRegistration(secretId, request);
        if (updated === undefined) return undefined;
        await secretRegister(this.#tx(), updated);
        this.#secrets.register(updated);
        return this.#secrets.reference(secretId);
    }

    async repairInterruptedSessions(reason: SessionInterruption["reason"]): Promise<void> {
        for (const { activeRunId, sessionId } of await queryInterruptedSessionCandidates(
            this.#tx(),
        )) {
            if (
                activeRunId !== undefined &&
                (await this.#reconcileTerminalRunState(sessionId, activeRunId))
            ) {
                continue;
            }
            const session = await this.get(sessionId);
            if (session === undefined) {
                continue;
            }

            const state = session.state();
            const runId = state.activeRunId ?? state.queuedRuns.at(0)?.runId;
            if (
                activeRunId === undefined &&
                state.scope.kind === "workspace" &&
                state.queuedRuns.length > 0 &&
                state.workspaceQueueWaiting === true
            ) {
                await session.workspaceReadinessChanged();
                continue;
            }
            if (session.hasDurableToolRun()) {
                await session.resumeDurableToolRun();
                continue;
            }
            if (session.isSubagent() && state.status === "suspended") {
                const message =
                    "The subagent stopped working because the local server restarted before its suspended run finished.";
                await session.markSuspendedAfterRestart(message, runId);
                const parentSessionId = session.agentMetadata().parentSessionId;
                const parent =
                    parentSessionId === undefined ? undefined : await this.get(parentSessionId);
                this.#agentManager.recordChanged(session);
                if (parent !== undefined) {
                    const subagent = session.subagentSummary();
                    const path = this.#agentManager.inspect(parent.id, subagent.agentId).path;
                    await parent.recordSubagentStoppedAfterRestart(subagent, path);
                }
                continue;
            }
            await session.markInterrupted({
                interruptedAt: this.#now(),
                message:
                    reason === "crash"
                        ? "The session was interrupted because the local server stopped before the run completed."
                        : "The session was interrupted because the local server shut down before the run completed.",
                reason,
                ...(runId !== undefined ? { runId } : {}),
            });
            const parentSessionId = session.agentMetadata().parentSessionId;
            if (parentSessionId !== undefined) {
                await this.get(parentSessionId);
                this.#agentManager.recordChanged(session);
            }
        }
    }

    async #reconcileTerminalRunState(sessionId: string, runId: string): Promise<boolean> {
        const event = await queryTerminalRunEvent(this.#tx(), sessionId, runId);
        if (event === undefined) return false;
        await sessionReconcileTerminalRun(this.#tx(), {
            lastEventId: event.lastEventId,
            runId,
            sessionId,
            status: event.status,
            updatedAt: this.#now(),
        });
        return true;
    }

    async prepareForShutdown(reason: SessionInterruption["reason"]): Promise<void> {
        this.#taskDrain?.beginClose();
        if (this.#scheduledMessageTimer !== undefined) {
            clearTimeout(this.#scheduledMessageTimer);
            this.#scheduledMessageTimer = undefined;
        }
        if (this.#unsortedSweepTimer !== undefined) {
            clearInterval(this.#unsortedSweepTimer);
            this.#unsortedSweepTimer = undefined;
        }
        if (this.#unsortedSweepFollowup !== undefined) {
            clearImmediate(this.#unsortedSweepFollowup);
            this.#unsortedSweepFollowup = undefined;
        }
        if (this.#toolResultSweepTimer !== undefined) {
            clearInterval(this.#toolResultSweepTimer);
            this.#toolResultSweepTimer = undefined;
        }
        if (this.#toolResultSweepFollowup !== undefined) {
            clearImmediate(this.#toolResultSweepFollowup);
            this.#toolResultSweepFollowup = undefined;
        }
        const closingSessions = new Set(this.#cachedSessions());
        const cleanup: Promise<void>[] = [
            ...[...closingSessions].map((session) => session.beginShutdown()),
            this.remoteTerminals.close(),
        ];
        let repairError: unknown;
        try {
            await this.repairInterruptedSessions(reason);
        } catch (error) {
            repairError = error;
        }
        for (const session of this.#cachedSessions()) {
            if (closingSessions.has(session)) continue;
            cleanup.push(session.beginShutdown());
        }
        const cleanupResults = await Promise.allSettled(cleanup);
        await this.#taskDrain?.drain();
        const cleanupErrors = cleanupResults
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (repairError !== undefined || cleanupErrors.length > 0) {
            throw new AggregateError(
                [...(repairError === undefined ? [] : [repairError]), ...cleanupErrors],
                "The local daemon could not finish session cleanup.",
            );
        }
    }

    async saveSession(state: PersistedSessionState): Promise<void> {
        validOwnerInstanceId(state.ownerInstanceId);
        const contextMessages =
            state.contextMessages ??
            state.messages
                .filter((message) => !message.isPartial)
                .sort((left, right) => left.position - right.position)
                .map((message) => message.message);
        await sessionSave(this.#tx(), state, {
            contextMessages,
            now: this.#now(),
        });
    }

    async setWorkspaceTransferState(
        input: Parameters<NonNullable<InMemorySessionPersistence["setWorkspaceTransferState"]>>[0],
    ): Promise<void> {
        await sessionSetWorkspaceTransferState(this.#tx(), { ...input, now: this.#now() });
    }

    async transferWorkspace(input: {
        contextMessages: readonly Message[];
        cwd: string;
        sessionId: string;
        state: Parameters<typeof sessionTransferWorkspace>[1]["state"];
        projectId: string;
        workspaceId: string;
    }): Promise<string> {
        const scope: SessionScope = {
            kind: "workspace",
            projectId: input.projectId,
            workspaceId: input.workspaceId,
        };
        const orderKey = await this.#newLastSessionOrderKey(scope);
        await sessionTransferWorkspace(this.#tx(), { ...input, now: this.#now(), orderKey });
        return orderKey;
    }

    async transferSession(
        sessionId: string,
        request: TransferSessionRequest,
    ): Promise<TransferSessionResponse | undefined> {
        return this.#executeSessionTransfer(sessionId, request.targetWorkspaceId, false);
    }

    async #executeSessionTransfer(
        sessionId: string,
        targetWorkspaceId: string,
        scheduled: boolean,
    ): Promise<TransferSessionResponse | undefined> {
        this.#assertAcceptingMutations();
        const session = await this.get(sessionId);
        if (session === undefined) return undefined;
        return executeSessionWorkspaceTransfer({
            hasAttachedSessions: async (workspaceId) =>
                await queryWorkspaceHasAttachedSessions(this.#tx(), workspaceId),
            projects: this.#projects,
            releaseTarget: (workspaceId, ownerSessionId) =>
                this.#releaseWorkspaceTransferTarget(workspaceId, ownerSessionId),
            reserveTarget: (workspaceId, ownerSessionId) =>
                this.#reserveWorkspaceTransferTarget(workspaceId, ownerSessionId),
            scheduled,
            session,
            targetWorkspaceId,
        });
    }

    async query<T>(operation: (tx: TX) => T | Promise<T>): Promise<T> {
        this.#assertOpen();
        return await operation(this.#tx());
    }

    transaction<T>(operation: (tx: TX) => T | Promise<T>): Promise<T> {
        return this.#transaction(operation);
    }

    #assertAcceptingMutations(): void {
        if (this.#taskDrain?.closing === true) {
            throw new Error("The local daemon is shutting down.");
        }
    }

    async upsertMessage(sessionId: string, message: PersistedSessionMessage): Promise<void> {
        await sessionSaveMessage(this.#tx(), sessionId, message, this.#now());
    }

    async loadTranscriptPage(
        sessionId: string,
        turnLimit: number,
        before?: string,
    ): Promise<SessionTranscriptWindow | undefined> {
        const page = await querySessionTranscriptPage(this.#tx(), sessionId, turnLimit, before);
        if (page === undefined) return undefined;
        const firstPosition = page.messages[0]?.position;
        const hasEarlier =
            firstPosition !== undefined &&
            (await querySessionHasEarlierTranscriptMessage(this.#tx(), sessionId, firstPosition));
        return await this.#transcriptWindowForMessages(
            sessionId,
            page.messages,
            turnLimit,
            !hasEarlier,
            page.noticesTruncated,
        );
    }

    async loadTranscriptSince(
        sessionId: string,
        turnLimit: number,
        after: EventId,
    ): Promise<SessionTranscriptWindow | undefined> {
        const range = await querySessionTranscriptSince(this.#tx(), sessionId, turnLimit, after);
        if (range === undefined) return undefined;
        const lastPosition = range.messages.at(-1)?.position;
        const hasLater =
            lastPosition !== undefined &&
            (await querySessionHasLaterTranscriptMessage(this.#tx(), sessionId, lastPosition));
        return await this.#transcriptWindowForMessages(
            sessionId,
            range.messages,
            turnLimit,
            !hasLater,
            range.truncated,
        );
    }

    async upsertExternalToolCall(call: ExternalToolCall): Promise<void> {
        await externalToolCallSave(this.#tx(), call);
    }

    async handoffDurablePermissionToExternalTool(
        externalCall: ExternalToolCall,
        permissionCall: DurableUserInputCall,
    ): Promise<void> {
        await durablePermissionHandoff(this.#tx(), externalCall, permissionCall);
    }

    async upsertDurableUserInput(call: DurableUserInputCall): Promise<void> {
        await durableUserInputSave(this.#tx(), call);
    }

    async upsertDurableWait(wait: DurableWait): Promise<void> {
        await durableWaitSave(this.#tx(), wait);
    }

    async upsertScheduledMessage(message: ScheduledMessage): Promise<void> {
        await scheduledMessageSave(this.#tx(), message);
    }

    async scheduledMessageChanged(): Promise<void> {
        await this.#afterTransactionCommit(() => this.#armScheduledMessageTimer());
    }

    async pruneExternalToolCalls(sessionId: string, retain: number): Promise<void> {
        await externalToolCallPrune(this.#tx(), sessionId, retain);
    }

    async pruneDurableUserInputs(sessionId: string, retain: number): Promise<void> {
        await durableUserInputPrune(this.#tx(), sessionId, retain);
    }

    async pruneDurableWaits(sessionId: string, retain: number): Promise<void> {
        await durableWaitPrune(this.#tx(), sessionId, retain);
    }

    async pruneScheduledMessages(sessionId: string, retain: number): Promise<readonly string[]> {
        return await scheduledMessagePrune(this.#tx(), sessionId, retain);
    }

    async #armScheduledMessageTimer(): Promise<void> {
        if (this.#database.closed) return;
        if (this.#scheduledMessageTimer !== undefined) clearTimeout(this.#scheduledMessageTimer);
        const next = await queryNextPendingScheduledMessage(this.#tx());
        if (next === undefined) {
            this.#scheduledMessageTimer = undefined;
            return;
        }
        const delay = Math.min(MAX_SCHEDULE_TIMER_DELAY_MS, Math.max(0, next.dueAt - this.#now()));
        this.#scheduledMessageTimer = setTimeout(() => {
            this.#scheduledMessageTimer = undefined;
            void this.#deliverDueScheduledMessages().catch(rethrowDatabaseFailure);
        }, delay);
    }

    /**
     * Puts away the Unsorted chats that have run out of time.
     *
     * A chat can start belonging nowhere and file itself into a folder while the user talks to it.
     * One that never does is archived a day after it began waiting, through the same archival every
     * other chat goes through, so Unsorted holds only the work somebody is still sorting. A chat
     * that never started out Unsorted, which is every chat a project or workspace holds, is not
     * swept at all.
     */
    async archiveExpiredUnsortedSessions(): Promise<boolean> {
        if (this.#database.closed) return false;
        const unsortedBefore = this.#now() - UNSORTED_SESSION_ARCHIVE_AFTER_MS;
        const deadline = Date.now() + UNSORTED_SWEEP_MAX_MS;
        let archived = 0;
        while (archived < UNSORTED_SWEEP_MAX_SESSIONS && Date.now() <= deadline) {
            const expired = await queryExpiredUnsortedSessions(
                this.#tx(),
                unsortedBefore,
                Math.min(UNSORTED_SWEEP_LIMIT, UNSORTED_SWEEP_MAX_SESSIONS - archived),
            );
            if (expired.length === 0) return false;
            for (const sessionId of expired) {
                if (this.#database.closed) return false;
                const session = await this.get(sessionId);
                if (session !== undefined) {
                    // An Unsorted root may be idle while one of its background agents is still
                    // running. Expiry is terminal for the whole retained tree, just like archiving
                    // the folder that owns one, so no hidden descendant keeps acting after the
                    // root disappears from Unsorted.
                    await session.recordFolderArchived();
                }
                archived += 1;
            }
            if (expired.length < UNSORTED_SWEEP_LIMIT) return false;
        }
        return true;
    }

    #armUnsortedSweepTimer(): void {
        // The first pass waits for the constructor to finish, the way other startup maintenance
        // does, so opening the store never blocks on working through a backlog of stale chats.
        this.#scheduleUnsortedSweep();
        this.#unsortedSweepTimer = setInterval(
            () => this.#sweepUnsortedSessions(),
            UNSORTED_SWEEP_INTERVAL_MS,
        );
        this.#unsortedSweepTimer.unref();
    }

    async #sweepUnsortedSessions(): Promise<void> {
        try {
            if (await this.archiveExpiredUnsortedSessions()) this.#scheduleUnsortedSweep();
        } catch (error) {
            // Sweeping runs on its own, outside any request. A database that could not answer is
            // still fatal; one chat that refused to be put away must not take the daemon down.
            if (this.#database.closed) return;
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #scheduleUnsortedSweep(): void {
        if (this.#database.closed || this.#unsortedSweepFollowup !== undefined) return;
        this.#unsortedSweepFollowup = setImmediate(() => {
            this.#unsortedSweepFollowup = undefined;
            void this.#sweepUnsortedSessions();
        });
        this.#unsortedSweepFollowup.unref();
    }

    async pruneStaleToolResults(): Promise<boolean> {
        if (this.#database.closed || this.#toolResultRetentionMs === undefined) return false;
        const before = this.#now() - this.#toolResultRetentionMs;
        const deadline = Date.now() + TOOL_RESULT_SWEEP_MAX_MS;
        let scanned = 0;
        while (scanned < TOOL_RESULT_SWEEP_MAX_SCANNED_MESSAGES && Date.now() <= deadline) {
            const page = await sessionPruneToolResults(this.#tx(), {
                ...(this.#toolResultSweepCursor === undefined
                    ? {}
                    : { after: this.#toolResultSweepCursor }),
                before,
                limit: TOOL_RESULT_SWEEP_BATCH_LIMIT,
            });
            if (page.complete) {
                this.#toolResultSweepCursor = undefined;
                return false;
            }
            this.#toolResultSweepCursor = page.cursor;
            scanned += TOOL_RESULT_SWEEP_BATCH_LIMIT;
        }
        return true;
    }

    #armToolResultSweepTimer(): void {
        this.#scheduleToolResultSweep();
        this.#toolResultSweepTimer = setInterval(
            () => this.#sweepToolResults(),
            TOOL_RESULT_SWEEP_INTERVAL_MS,
        );
        this.#toolResultSweepTimer.unref();
    }

    async #sweepToolResults(): Promise<void> {
        try {
            if (await this.pruneStaleToolResults()) this.#scheduleToolResultSweep();
        } catch (error) {
            if (this.#database.closed) return;
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #scheduleToolResultSweep(): void {
        if (this.#database.closed || this.#toolResultSweepFollowup !== undefined) return;
        this.#toolResultSweepFollowup = setImmediate(() => {
            this.#toolResultSweepFollowup = undefined;
            void this.#sweepToolResults();
        });
        this.#toolResultSweepFollowup.unref();
    }

    async #deliverDueScheduledMessages(): Promise<void> {
        for (;;) {
            const next = await queryNextPendingScheduledMessage(this.#tx());
            if (next === undefined || next.dueAt > this.#now()) break;
            const sender = await this.get(next.senderSessionId);
            if (sender === undefined) {
                throw new Error("The sender of a scheduled message no longer exists.");
            }
            await sender.deliverScheduledMessage(next.id);
        }
        await this.#armScheduledMessageTimer();
    }

    async #appendEvent(event: SessionEvent): Promise<void> {
        if (isLiveOnlySessionEvent(event)) {
            await sessionAdvanceEventCursor(this.#tx(), event.sessionId, event.id, this.#now());
            await this.#afterTransactionCommit(async () => {
                await this.#publishLiveStream(event);
                await this.#publishGlobalEvent(event);
                await this.#notifySessionEvent(event);
            });
            return;
        }
        const eventFacts = sessionEventFacts(event);
        const precommitted = this.#precommittedGlobalEvents.has(event.id);
        let globalEntry = this.#precommittedGlobalEvents.get(event.id) ?? undefined;
        this.#precommittedGlobalEvents.delete(event.id);
        let inserted = false;
        await this.#transaction(async (tx) => {
            inserted =
                (await sessionAppendEvent(tx, event, eventFacts, this.#now())) === "inserted";
            if (!precommitted && inserted && this.#globalEventQueue.durable) {
                globalEntry = await this.#globalEventQueue.append(event, tx);
            }
        });
        // The live stream carries this event whether or not the durable log
        // keeps it, but never before the row it describes is committed.
        await this.#afterTransactionCommit(() => this.#publishLiveStream(event));
        if (this.#globalEventQueue.durable && globalEntry !== undefined) {
            const queue = this.#globalEventQueue;
            await this.#afterTransactionCommit(() => queue.publish(globalEntry!));
        } else if (
            (inserted || precommitted) &&
            !this.#globalEventQueue.durable &&
            shouldPublishGlobalEvent(event)
        ) {
            const queue = this.#globalEventQueue;
            await this.#afterTransactionCommit(async () => {
                const entry = await queue.append(event);
                if (entry !== undefined) queue.publish(entry);
            });
        }
        await this.#afterTransactionCommit(() => this.#notifySessionEvent(event));
    }

    /**
     * Puts an event on the ephemeral stream every local client follows.
     *
     * Session events arrive here through `#appendEvent`, which has already done
     * this, so only the rest are forwarded from `#publishGlobalEvent`.
     */
    async #publishLiveStream(event: GlobalEvent): Promise<void> {
        const queue = this.liveEvents;
        await this.#afterTransactionCommit(() => {
            queue.publish(event);
        });
    }

    async #projectEvent(event: GlobalEvent): Promise<void> {
        await this.#publishGlobalEvent(event);
        if (event.type !== "workspace_created" && event.type !== "workspace_updated") return;
        if (event.data.workspace.status === "initializing") return;
        await this.#afterTransactionCommit(async () => {
            await this.#workspaceReadyWaiters.changed(event.projectId, event.workspaceId);
            await this.#workspaceReadinessChanged(event.workspaceId);
        });
    }

    async #workspaceReadinessChanged(workspaceId: string): Promise<void> {
        for (const sessionId of await queryWorkspaceQueuedSessionIds(this.#tx(), workspaceId)) {
            await (await this.get(sessionId))?.workspaceReadinessChanged();
        }
    }

    async #publishGlobalEvent(event: GlobalEvent): Promise<void> {
        if (!("sessionId" in event)) await this.#publishLiveStream(event);
        if (isLiveGlobalEvent(event)) {
            const queue = this.#globalEventQueue;
            await this.#afterTransactionCommit(() => {
                queue.publishLive(event);
            });
            return;
        }
        if (!shouldPublishGlobalEvent(event)) return;
        const queue = this.#globalEventQueue;
        if (!queue.durable) {
            await this.#afterTransactionCommit(async () => {
                const entry = await queue.append(event);
                if (entry !== undefined) queue.publish(entry);
            });
            return;
        }
        const entry = await queue.append(event, this.#tx());
        if (entry !== undefined) {
            await this.#afterTransactionCommit(() => queue.publish(entry));
        }
    }

    async #notifySessionAccess(session: InMemorySession): Promise<void> {
        // Observers own their own database connections. One that writes while this store still
        // holds the write lock would wait for a transaction that cannot commit until the observer
        // returns, so every notification waits for the commit.
        await this.#afterTransactionCommit(() => {
            try {
                this.#onSessionAccess?.(session);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                // External synchronization must never interrupt local session access.
            }
        });
    }

    async #notifySessionEvent(event: SessionEvent): Promise<void> {
        try {
            await this.#onSessionEvent?.(event, this.#sessions.get(event.sessionId)?.deref());
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            // The event is already durable; optional observers cannot roll it back.
        }
    }

    async #loadSecretRegistrations(): Promise<void> {
        const loaded = await querySecretRegistrations(this.#tx());
        for (const registration of loaded.registrations) this.#secrets.register(registration);
        for (const variable of loaded.environmentVariables) {
            this.#secrets.rememberEnvironmentVariables(variable.secretId, [variable.name]);
        }
    }

    async #inheritWorkspaceName(
        metadata: Parameters<NonNullable<InMemorySessionOptions["onInitialTitle"]>>[0],
    ): Promise<void> {
        const firstSessionId = await queryFirstRootSessionIdForWorkspace(
            this.#tx(),
            metadata.projectId,
            metadata.workspaceId,
        );
        if (firstSessionId !== metadata.sessionId) return;
        await this.#projects.inheritWorkspaceName(
            metadata.projectId,
            metadata.workspaceId,
            metadata.title,
        );
    }

    async #loadSession(sessionId: string): Promise<InMemorySession | undefined> {
        const loaded = await querySessionRestore(this.#tx(), sessionId);
        if (loaded === undefined) return undefined;
        const ownerInstanceId = validOwnerInstanceId(loaded.restore.ownerInstanceId);
        const folderPath =
            loaded.restore.scope.kind === "folder"
                ? await this.#folders.folderStoragePath(loaded.restore.scope.folderId)
                : undefined;
        const request =
            folderPath === undefined
                ? loaded.request
                : (() => {
                      const { docker: _docker, ...request } = loaded.request;
                      return { ...request, cwd: folderPath };
                  })();
        const restore =
            folderPath === undefined
                ? loaded.restore
                : (() => {
                      const { docker: _docker, ...restore } = loaded.restore;
                      return { ...restore, cwd: folderPath };
                  })();
        return await InMemorySession.open({
            presence: this.presence,
            agentManager: this.#agentManager,
            workspaceFeatures: this.#workspaceFeatures,
            workspaceRunReadiness: (target) => workspaceRunReadiness(this.#projects, target),
            createEventId: createEventIdFactory(
                loaded.lastEventId === undefined ? {} : { after: loaded.lastEventId },
            ),
            ...(this.#createRuntime === undefined ? {} : { createRuntime: this.#createRuntime }),
            deferEventNotification: (notify) => this.#afterTransactionCommit(notify),
            events: await querySessionEvents(this.#tx(), sessionId, RESTORED_SESSION_EVENT_LIMIT),
            ...(loaded.lastEventId === undefined ? {} : { lastEventId: loaded.lastEventId }),
            modelCatalog: this.#modelCatalogFor(ownerInstanceId),
            now: this.#now,
            onInitialTitle: async (metadata) => await this.#inheritWorkspaceName(metadata),
            ...(this.#mcpToolProvider === undefined
                ? {}
                : { mcpToolProvider: this.#mcpToolProvider }),
            onAppendEvent: async (event) => await this.#appendEvent(event),
            persistence: this,
            folders: this.#folders,
            slotStores: { entries: this.slots, applets: this.applets },
            ...(loaded.restore.scope.kind === "project" || loaded.restore.scope.kind === "workspace"
                ? {
                      projectSecretIds: await queryProjectSecretIds(
                          this.#tx(),
                          loaded.restore.scope.projectId,
                      ),
                  }
                : {}),
            ownerInstanceId,
            resolveGitAuthentication: async (projectId, creator) =>
                await this.#projects.gitAuthentication(projectId, creator),
            resolveProfile: async (profileId) => await queryRigProfile(this.#tx(), profileId),
            request,
            secretRegistry: this.#secrets,
            restore,
            scope: loaded.restore.scope,
            ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
        });
    }

    #cacheSession(session: InMemorySession): void {
        const previous = this.#sessions.get(session.id);
        if (previous !== undefined) this.#sessionFinalizer.unregister(previous);
        const reference = new WeakRef(session);
        this.#sessions.set(session.id, reference);
        this.#sessionFinalizer.register(session, { id: session.id, reference }, reference);
    }

    #modelCatalogFor(ownerInstanceId: string): ModelCatalog {
        return ownerInstanceId === this.localInstanceId
            ? this.#modelCatalog
            : this.#resolveModelCatalog(ownerInstanceId);
    }

    #cachedSessions(): InMemorySession[] {
        const sessions: InMemorySession[] = [];
        for (const [id, reference] of this.#sessions) {
            const session = reference.deref();
            if (session === undefined) {
                this.#sessions.delete(id);
                this.#sessionFinalizer.unregister(reference);
                continue;
            }
            sessions.push(session);
        }
        return sessions;
    }

    #cachedSession(sessionId: string): InMemorySession | undefined {
        const reference = this.#sessions.get(sessionId);
        const session = reference?.deref();
        if (session === undefined && reference !== undefined) this.#sessions.delete(sessionId);
        return session;
    }

    async #loadAgentTree(session: InMemorySession): Promise<void> {
        if (session.isSubagent()) return;
        for (const sessionId of await queryAgentTreeSessionIds(this.#tx(), session.id)) {
            if (sessionId === session.id) continue;
            if (this.#cachedSession(sessionId) !== undefined) continue;
            const child = await this.#loadSession(sessionId);
            if (child !== undefined) this.#cacheSession(child);
        }
    }

    async #newLastSessionOrderKey(scope: SessionScope): Promise<string> {
        const items = await this.#sessionOrderItems(scope);
        return generateKeyBetween(items.at(-1)?.orderKey ?? null, null);
    }

    #assertWorkspaceAcceptingSessions(workspaceId: string): void {
        if (this.#workspaceTransferReservations.has(workspaceId)) {
            throw new Error(
                "That workspace is receiving a session transfer and cannot start another session yet.",
            );
        }
    }

    #reserveWorkspaceTransferTarget(workspaceId: string, sessionId: string): void {
        const owner = this.#workspaceTransferReservations.get(workspaceId);
        if (owner !== undefined && owner !== sessionId) {
            throw new Error("That workspace is already reserved for another session transfer.");
        }
        this.#workspaceTransferReservations.set(workspaceId, sessionId);
    }

    #releaseWorkspaceTransferTarget(workspaceId: string, sessionId: string): void {
        if (this.#workspaceTransferReservations.get(workspaceId) === sessionId) {
            this.#workspaceTransferReservations.delete(workspaceId);
        }
    }

    async #sessionOrderItems(scope: SessionScope): Promise<{ id: string; orderKey: string }[]> {
        return await querySessionOrderItems(this.#tx(), scope);
    }

    async #transcriptWindowForMessages(
        sessionId: string,
        messages: readonly PersistedSessionMessage[],
        turnLimit: number,
        complete: boolean,
        noticesTruncated: boolean,
    ): Promise<SessionTranscriptWindow | undefined> {
        const events = await querySessionTranscriptEvents(this.#tx(), sessionId, messages);
        const eventLog = new SessionEventLog({
            events,
            retentionLimit: Number.MAX_SAFE_INTEGER,
        });
        const entries = messages
            .filter((entry) => !entry.isPartial)
            .map((entry): TranscriptEntry => {
                const createdAt = eventLog.messageCreatedAt(entry.message.id);
                const eventId = eventLog.messageEventId(entry.message.id);
                const steeredAt = eventLog.messageSteeredAt(entry.message.id);
                return {
                    ...(createdAt === undefined ? {} : { createdAt }),
                    ...(eventId === undefined ? {} : { eventId }),
                    message: entry.message,
                    ...(entry.runId === undefined ? {} : { runId: entry.runId }),
                    ...(steeredAt === undefined ? {} : { steeredAt }),
                };
            });
        const window = sessionTranscriptWindow(
            entries,
            transcriptRunFacts(events),
            turnLimit,
            undefined,
        );
        if (window === undefined) return undefined;
        const toolCallIds = new Set(
            window.messages.flatMap((message) =>
                message.blocks.flatMap((block) => (block.type === "tool_call" ? [block.id] : [])),
            ),
        );
        const permissionReviews = eventLog.permissionReviews(toolCallIds);
        return {
            ...window,
            complete,
            ...(noticesTruncated ? { noticesTruncated: true } : {}),
            ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
        };
    }

    /**
     * The container environment a scope's terminals run in, or `undefined`.
     *
     * The same answer `#remoteTerminalContext` computes, exposed because peer
     * access has to ask it before it will mirror a terminal to anybody: a
     * terminal with no container is a terminal that can read the owner's
     * credentials. Asking the one resolver rather than re-deriving it keeps that
     * decision from drifting away from what the terminal actually got.
     *
     * Returns `undefined` rather than throwing for a scope that cannot open a
     * terminal at all, because "no container here" is the answer that fails
     * closed either way.
     */
    async remoteTerminalDocker(
        scope: RemoteTerminalScope,
    ): Promise<DockerExecutionConfig | undefined> {
        try {
            return (await this.#remoteTerminalContext(scope)).docker;
        } catch {
            return undefined;
        }
    }

    async #remoteTerminalContext(
        scope: RemoteTerminalScope,
    ): Promise<ProjectRemoteTerminalContext> {
        const project = await this.#projects.getProject(scope.projectId);
        if (project === undefined) throw new Error("Project not found.");
        if (project.archivedAt !== undefined) {
            throw new Error("Archived projects cannot open terminals.");
        }
        const workspace =
            scope.workspaceId === undefined
                ? undefined
                : await this.#projects.getWorkspace(scope.projectId, scope.workspaceId);
        if (scope.workspaceId !== undefined && workspace === undefined) {
            throw new Error("Workspace not found.");
        }
        if (
            workspace !== undefined &&
            (
                await workspaceRunReadiness(this.#projects, {
                    cwd: workspace.path,
                    projectId: workspace.projectId,
                    workspaceId: workspace.id,
                })
            ).state !== "ready"
        ) {
            throw new Error("Only ready, available workspaces can open terminals.");
        }
        const cwd = workspace?.path ?? project.path;
        const docker = (
            await configureSessionRequest(
                { cwd },
                this.#defaultDocker,
                async () => await this.#projects.queryProjectSettings(cwd),
            )
        ).docker;
        return {
            cwd,
            ...(docker === undefined ? {} : { docker }),
        };
    }

    async #projectSecrets(projectId: string): Promise<readonly string[]> {
        return await queryProjectSecretIds(this.#tx(), projectId);
    }

    async #recoverProjectWorkspaces(): Promise<void> {
        // Each step resumes after an await, by which point the store may have been closed. Asking a
        // connection that is already gone would fail for a reason that is not a database fault.
        if (this.#database.closed) return;
        for (const workspace of await this.#projects.listWorkspaces()) {
            if (workspace.status !== "archiving") continue;
            if (this.#database.closed) return;
            await this.#archiveWorkspace(workspace.projectId, workspace.id);
        }
        if (this.#database.closed) return;
        await this.#projects.reconcileInitializingWorkspaces();
        if (this.#database.closed) return;
        // Presence and Git facts are enrichment, so they run only after archival recovery, which is
        // user-visible correctness.
        await this.#projects.reconcileGitFacts();
    }

    async #repairInterruptedTitleGenerations(): Promise<void> {
        await sessionRepairInterruptedTitles(this.#tx(), this.#now());
    }

    #tx(): TX {
        this.#assertOpen();
        return sessionTransactionScope(this.#database);
    }

    /**
     * Background work outlives the store that started it, so a session can still try to save after
     * shutdown closed the connection. Asking a closed connection reports that it is not open, which
     * is indistinguishable from a real fault once it escapes. Refusing here keeps a deliberate
     * shutdown from being mistaken for a database that could not answer.
     */
    #assertOpen(): void {
        if (!this.#database.closed) return;
        throw new Error("The session database is closed.");
    }

    async #transaction<T>(body: (tx: TX) => T | Promise<T>): Promise<T> {
        this.#assertOpen();
        return await runSessionTransaction(this.#database, body);
    }

    #afterTransactionCommit(callback: () => void | Promise<void>): Promise<void> {
        return deferSessionTransactionCommit(callback, this.#database);
    }

    afterTransactionCommit(callback: () => void | Promise<void>): Promise<void> {
        return this.#afterTransactionCommit(callback);
    }
}

function sessionEventFacts(event: SessionEvent): {
    messageId?: string;
    runId?: string;
    toolCallId?: string;
} {
    const data = event.data as unknown as Record<string, unknown>;
    const message =
        typeof data.message === "object" && data.message !== null
            ? (data.message as Record<string, unknown>)
            : undefined;
    const inner =
        typeof data.event === "object" && data.event !== null
            ? (data.event as Record<string, unknown>)
            : undefined;
    return {
        ...(typeof message?.id === "string" ? { messageId: message.id } : {}),
        ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
        ...(typeof inner?.toolCallId === "string" ? { toolCallId: inner.toolCallId } : {}),
    };
}

function persistentCodeScope(
    scope: SessionScope,
): Extract<SessionScope, { kind: "project" | "workspace" }> {
    if (scope.kind === "project" || scope.kind === "workspace") return scope;
    throw new Error("This operation is available only for project or workspace chats.");
}

function validOwnerInstanceId(value: string): string {
    if (!Value.Check(p2pInstanceIdSchema, value)) {
        throw new Error("The session owner Rig identity is invalid.");
    }
    return value;
}
