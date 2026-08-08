import { chmodSync, mkdirSync } from "node:fs";
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
    CreateFolderRequest,
    CreateProjectWorkspaceRequest,
    CreateRemoteProjectRequest,
    CreateSessionRequest,
    EventId,
    Folder,
    GetTimelineRequest,
    GitChangeSnapshot,
    GitRepositoryFacts,
    GlobalEventQueueEntry,
    ModelCatalog,
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
    SessionScope,
    SessionTranscriptWindow,
    SubagentSummary,
    TimelineAgent,
    TransferSessionRequest,
    TransferSessionResponse,
    UpdateFolderRequest,
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
import { InMemoryGlobalEventQueue } from "../global-event/InMemoryGlobalEventQueue.js";
import { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";
import {
    ProjectRepository,
    type ProjectAvatarAsset,
    type ProjectRepositoryOptions,
    type ProjectSessionSettings,
} from "../project/ProjectRepository.js";
import { FolderRepository } from "../folders/FolderRepository.js";
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
import { querySubagentSessionIdsByRoot } from "../persistence/session/querySubagentSessionIdsByRoot.js";
import { querySubagentSummaries } from "../persistence/session/querySubagentSummaries.js";
import { queryTimelineAgents } from "../persistence/timeline/queryTimelineAgents.js";
import { queryTimelineEvents } from "../persistence/timeline/queryTimelineEvents.js";
import { queryAgentTreeUsage as queryPersistedAgentTreeUsage } from "../persistence/session/queryAgentTreeUsage.js";
import { buildTimeline } from "../timeline/index.js";
import { sessionOrderKeyForCreation } from "./impl/sessionOrderKeyForCreation.js";
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
    onSessionEvent?: (event: SessionEvent, session: InMemorySession | undefined) => void;
    onWorkspaceBranchError?: (error: unknown, projectId: string, workspaceId: string) => void;
    onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
    presence?: PresenceStore;
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
    #client: ReturnType<typeof openSessionDatabase>["client"];
    #createRuntime: InMemorySessionOptions["createRuntime"];
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #createPresenceEventId = createEventIdFactory();
    readonly #createTerminalEventId = createEventIdFactory();
    #database: SessionDatabase;
    readonly dataEpoch: string;
    readonly dataSchemaVersion: number;
    #modelCatalog: ModelCatalog;
    readonly #localInstanceId: string;
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
    #activeTransaction: TX | undefined;
    #transactionCommitCallbacks: (() => void)[] | undefined;
    readonly liveEvents = new LiveGlobalEventQueue();
    readonly happyCloud: HappyCloudService;
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    readonly slots: SlotEntryStore;
    readonly applets: AppletStore;
    readonly worklets: WorkletStore;

    constructor(options: PersistentSessionStoreOptions) {
        this.#localInstanceId = validOwnerInstanceId(options.localInstanceId ?? createId());
        this.#resolveModelCatalog =
            options.resolveModelCatalog ?? (() => options.modelCatalog ?? createModelCatalog());
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
        this.#modelCatalog = this.#resolveModelCatalog(this.#localInstanceId);
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
        if (options.databasePath !== ":memory:") {
            mkdirSync(dirname(options.databasePath), { mode: 0o700, recursive: true });
        }
        const opened = openSessionDatabase(options.databasePath);
        this.#client = opened.client;
        this.#database = opened.database;
        if (options.databasePath !== ":memory:") chmodSync(options.databasePath, 0o600);
        migrateSessionDatabase(this.#database, { localInstanceId: this.#localInstanceId });
        this.dataEpoch = queryRigDataEpoch(this.#database);
        this.dataSchemaVersion = querySessionDatabaseVersion(this.#database);
        if (this.dataSchemaVersion !== CURRENT_SESSION_DATABASE_VERSION) {
            throw new Error("The persistent Rig store did not reach the current schema version.");
        }
        this.#loadSecretRegistrations();
        for (const secret of options.secrets ?? []) this.registerSecret(secret);
        this.#globalEventQueue =
            options.durableGlobalEventQueue === true
                ? new PersistentGlobalEventQueue(this.#database)
                : new InMemoryGlobalEventQueue();
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
            sessionExists: (sessionId) =>
                querySlotScopeTargetExists(this.#tx(), "session", sessionId),
            tx: () => this.#tx(),
            applet: (name) => this.applets.get(name),
        });
        this.#projects = new ProjectRepository({
            ...(options.projectClone === undefined ? {} : { cloneRemote: options.projectClone }),
            database: this.#database,
            localInstanceId: this.#localInstanceId,
            ...(options.projectGit === undefined ? {} : { git: options.projectGit }),
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (event) => this.#projectEvent(event),
            resolveGitSecret: (kind) => this.#secrets.resolveSpecial(kind).GH_TOKEN,
            resolveProfile: (profileId) => queryRigProfile(this.#tx(), profileId),
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
            onFolderContextChanged: (folderIds) => {
                this.#afterTransactionCommit(() => {
                    const affected = new Set(folderIds);
                    for (const session of this.#cachedSessions()) {
                        if (session.belongsToFolderContext(affected))
                            session.folderContextChanged();
                    }
                });
            },
            onSessionsArchived: (sessionIds) => {
                this.#afterTransactionCommit(() => {
                    for (const sessionId of sessionIds) {
                        void this.get(sessionId)
                            ?.recordFolderArchived()
                            .catch(rethrowDatabaseFailure);
                    }
                });
            },
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
            localInstanceId: this.#localInstanceId,
            repository: {
                archiveOwnedWorkspace: async (ownerSessionId, projectId, workspaceId) =>
                    this.#projects.getOwnedWorkspace(ownerSessionId, projectId, workspaceId) ===
                    undefined
                        ? undefined
                        : this.#archiveWorkspace(projectId, workspaceId),
                createOwnedWorkspace: (ownerSessionId, projectId, request) => {
                    const owner = this.get(ownerSessionId)?.snapshot();
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
                configureWorkspaceRequest: (request) => this.#configureWorkspaceRequest(request),
                createSubagent: (request, metadata, contextMessages) =>
                    this.#createSession(request, metadata, contextMessages),
                createDelegatedSession: (request, metadata, id) =>
                    this.#createSession(request, metadata, undefined, id),
                findByAgentId: (agentId) => this.findByAgentId(agentId),
                get: (sessionId) => this.get(sessionId),
                listByRoot: (rootSessionId) => this.#listSubagentSessionsByRoot(rootSessionId),
                listProjects: () => this.#projects.listProjects(),
                registerProject: (path) => this.#projects.registerProject({ path }),
                listProjectWorkspaces: (projectId) => this.#projects.listWorkspaces(projectId),
                listProjectSessions: (target) => queryWorkspaceSessions(this.#tx(), target),
                queryAgentTreeUsage: (sessionId) => this.queryAgentTreeUsage(sessionId),
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
                scheduleSessionTransfer: (sessionId, targetWorkspaceId) => {
                    const session = this.get(sessionId);
                    if (session === undefined) {
                        throw new Error("The session is no longer available.");
                    }
                    return scheduleSessionWorkspaceTransfer({
                        hasAttachedSessions: (workspaceId) =>
                            queryWorkspaceHasAttachedSessions(this.#tx(), workspaceId),
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
        this.#repairInterruptedTitleGenerations();
        this.repairInterruptedSessions("crash");
        this.#armScheduledMessageTimer();
        this.#armUnsortedSweepTimer();
        if (this.#toolResultRetentionMs !== undefined) this.#armToolResultSweepTimer();
        const recover = () => this.#recoverProjectWorkspaces();
        const recovery = this.#taskDrain?.run(recover) ?? recover();
        void recovery.catch((error: unknown) => {
            // Recovery outlives a store that is closed while it runs. A connection this store
            // closed itself is shutdown rather than a database that could not answer.
            if (!this.#client.open) return;
            if (isDatabaseFailure(error)) throw error;
        });
    }

    changeModel(sessionId: string, request: ChangeModelRequest): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        session.changeModel(request);
        return session;
    }

    attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        this.#secrets.reference(secretId);
        if (scope === "project") {
            const projectId = persistentCodeScope(session.snapshot().scope).projectId;
            projectSecretAttach(this.#tx(), projectId, secretId);
            for (const candidate of this.#cachedSessions()) {
                const candidateScope = candidate.snapshot().scope;
                if (
                    (candidateScope.kind === "project" || candidateScope.kind === "workspace") &&
                    candidateScope.projectId === projectId
                ) {
                    candidate.attachSecret(secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            session.attachSecret(secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    changeEffort(sessionId: string, request: ChangeEffortRequest): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        session.changeEffort(request);
        return session;
    }

    changeServiceTier(
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        session.changeServiceTier(request);
        return session;
    }

    clearMessages(sessionId: string): void {
        sessionClearMessages(this.#tx(), sessionId);
    }

    deleteMessagesFrom(sessionId: string, position: number): void {
        sessionRewind(this.#tx(), sessionId, position);
    }

    close(): void {
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
        void this.remoteTerminals.close();
        this.#workspaceReadyWaiters.close();
        this.#projects.close();
        this.liveEvents.close();
        this.#globalEventQueue.deactivate();
        this.#client.close();
    }

    #configureWorkspaceRequest(request: CreateSessionRequest): CreateSessionRequest {
        const { docker: _docker, local: _local, ...base } = request;
        return configureSessionRequest(base, this.#defaultDocker, () =>
            this.#projects.queryProjectSettings(request.cwd),
        );
    }

    create(request: CreateSessionRequest, options: SessionCreationOptions = {}): InMemorySession {
        this.#assertAcceptingMutations();
        return this.#createSession(request, undefined, undefined, undefined, options);
    }

    /**
     * Creates a session under an identity its caller chose.
     *
     * The identity is only checked for shape where a client supplies it, at the
     * protocol boundary. Rig's own integrations derive identities of their own,
     * and they reach this method directly.
     */
    createWithId(
        id: string,
        request: CreateSessionRequest,
        options: SessionCreationOptions = {},
    ): InMemorySession {
        this.#assertAcceptingMutations();
        const existing = this.get(id);
        if (existing !== undefined) return retriedSession(existing, request);
        return this.#createSession(request, undefined, undefined, id, options);
    }

    detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = persistentCodeScope(session.snapshot().scope).projectId;
            projectSecretDetach(this.#tx(), projectId, secretId);
            for (const candidate of this.#cachedSessions()) {
                const candidateScope = candidate.snapshot().scope;
                if (
                    (candidateScope.kind === "project" || candidateScope.kind === "workspace") &&
                    candidateScope.projectId === projectId
                ) {
                    candidate.detachSecret(secretId, {
                        ...(candidate.id === sessionId && mutationId !== undefined
                            ? { mutationId }
                            : {}),
                        scope,
                    });
                }
            }
        } else {
            session.detachSecret(secretId, {
                ...(mutationId === undefined ? {} : { mutationId }),
                scope,
            });
        }
        return session;
    }

    fork(sessionId: string, targetSessionId?: string): InMemorySession | undefined {
        this.#assertAcceptingMutations();
        if (targetSessionId !== undefined) {
            const existing = this.get(targetSessionId);
            if (existing !== undefined) return existing;
        }
        const source = this.get(sessionId);
        if (source === undefined) return undefined;
        const sourceSnapshot = source.snapshot();
        const folderPath =
            sourceSnapshot.scope.kind === "folder"
                ? this.#folders.activeFolderStoragePath(sourceSnapshot.scope.folderId)
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
            const workspace = this.#projects.getWorkspace(
                sourceSnapshot.scope.projectId,
                sourceSnapshot.scope.workspaceId,
            );
            if (
                workspace === undefined ||
                workspaceRunReadiness(this.#projects, {
                    cwd: sourceSnapshot.cwd,
                    projectId: sourceSnapshot.scope.projectId,
                    workspaceId: sourceSnapshot.scope.workspaceId,
                }).state !== "ready"
            ) {
                throw new Error("A session in an unavailable workspace cannot be forked.");
            }
        }
        let session!: InMemorySession;
        this.#transaction(() => {
            session = new InMemorySession({
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
                onInitialTitle: (metadata) => this.#inheritWorkspaceName(metadata),
                ...(this.#mcpToolProvider !== undefined
                    ? { mcpToolProvider: this.#mcpToolProvider }
                    : {}),
                onAppendEvent: (event) => this.#appendEvent(event),
                persistence: this,
                folders: this.#folders,
                slotStores: { entries: this.slots, applets: this.applets },
                request: forkRequest,
                ...(sourceSnapshot.scope.kind === "project" ||
                sourceSnapshot.scope.kind === "workspace"
                    ? { projectSecretIds: this.#projectSecrets(sourceSnapshot.scope.projectId) }
                    : {}),
                ownerInstanceId: state.ownerInstanceId,
                ...(state.profileId === undefined ? {} : { profileId: state.profileId }),
                resolveGitAuthentication: (projectId, creator) =>
                    this.#projects.gitAuthentication(projectId, creator),
                resolveProfile: (profileId) => queryRigProfile(this.#tx(), profileId),
                secretRegistry: this.#secrets,
                restore: {
                    ...forkState,
                    ...(targetSessionId === undefined
                        ? {}
                        : {
                              agent: { ...forkState.agent, rootSessionId: targetSessionId },
                              id: targetSessionId,
                          }),
                    orderKey: this.#newLastSessionOrderKey(sourceSnapshot.scope),
                },
                scope: sourceSnapshot.scope,
                ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
            });
            for (const message of forkState.messages) {
                this.upsertMessage(session.id, message);
            }
            session.emitCreatedEvent();
        });
        this.#cacheSession(session);
        return session;
    }

    #createSession(
        request: CreateSessionRequest,
        metadata?: SessionAgentMetadata,
        contextMessages?: readonly Message[],
        id?: string,
        options: SessionCreationOptions = {},
    ): InMemorySession {
        this.#assertAcceptingMutations();
        const sessionId = id ?? createId();
        let session!: InMemorySession;
        let newUnsortedStorage: { created: boolean; path: string } | undefined;
        try {
            this.#transaction(() => {
                const inherited =
                    metadata?.parentSessionId === undefined
                        ? undefined
                        : this.get(metadata.parentSessionId)?.snapshot();
                if (metadata?.parentSessionId !== undefined && inherited === undefined) {
                    throw new Error("The parent session was not found.");
                }
                if (inherited?.status === "archived") {
                    throw new Error("An archived session cannot create a subagent.");
                }
                const ownerInstanceId =
                    inherited?.ownerInstanceId ??
                    (options.ownerInstanceId === undefined
                        ? this.#localInstanceId
                        : validOwnerInstanceId(options.ownerInstanceId));
                const profileId = inherited?.profileId ?? options.profileId ?? request.identity;
                if (profileId !== undefined) {
                    const profile = queryRigProfile(this.#tx(), profileId);
                    if (profile?.parentInstanceId !== ownerInstanceId) {
                        throw new Error("The session profile is not owned by the session's Rig.");
                    }
                }
                const inheritedWorkspace =
                    inherited?.scope.kind === "workspace"
                        ? this.#projects.getWorkspace(
                              inherited.scope.projectId,
                              inherited.scope.workspaceId,
                          )
                        : undefined;
                if (
                    inherited?.scope.kind === "workspace" &&
                    (inheritedWorkspace === undefined ||
                        workspaceRunReadiness(this.#projects, {
                            cwd: inherited.cwd,
                            projectId: inherited.scope.projectId,
                            workspaceId: inherited.scope.workspaceId,
                        }).state !== "ready")
                ) {
                    throw new Error("The parent session workspace is not ready and available.");
                }
                const resolved = (() => {
                    if (inherited === undefined) {
                        if (request.scope?.kind === "folder") {
                            return {
                                request: {
                                    ...request,
                                    cwd: this.#folders.activeFolderStoragePath(
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
                            const ownership = this.#projects.resolveSessionOwnership(
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
                        const ownership = this.#projects.resolve(
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
                        const ownership = this.#projects.resolve(
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
                                cwd: this.#folders.activeFolderStoragePath(
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
                if (
                    profileId !== undefined &&
                    (resolved.scope.kind === "project" || resolved.scope.kind === "workspace")
                ) {
                    const project = this.#projects.getProject(resolved.scope.projectId);
                    const workspace =
                        resolved.scope.kind === "workspace"
                            ? this.#projects.getWorkspace(
                                  resolved.scope.projectId,
                                  resolved.scope.workspaceId,
                              )
                            : undefined;
                    const creator = workspace?.createdBy ?? project?.createdBy;
                    if (
                        creator !== undefined &&
                        (creator.instanceId !== ownerInstanceId || creator.profileId !== profileId)
                    ) {
                        throw new Error(
                            "That project or workspace belongs to another human profile.",
                        );
                    }
                }
                if (resolved.scope.kind === "workspace") {
                    this.#assertWorkspaceAcceptingSessions(resolved.scope.workspaceId);
                }
                const projectId =
                    resolved.scope.kind === "project" || resolved.scope.kind === "workspace"
                        ? resolved.scope.projectId
                        : undefined;
                session = new InMemorySession({
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
                    onInitialTitle: (metadata) => this.#inheritWorkspaceName(metadata),
                    ...(this.#mcpToolProvider !== undefined
                        ? { mcpToolProvider: this.#mcpToolProvider }
                        : {}),
                    ...(metadata !== undefined ? { metadata } : {}),
                    ...(contextMessages !== undefined
                        ? { initialContextMessages: contextMessages }
                        : {}),
                    id: sessionId,
                    onAppendEvent: (event) => this.#appendEvent(event),
                    orderKey: sessionOrderKeyForCreation(metadata?.type, () =>
                        this.#newLastSessionOrderKey(resolved.scope),
                    ),
                    ownerInstanceId,
                    ...(profileId === undefined ? {} : { profileId }),
                    resolveGitAuthentication: (candidateProjectId, creator) =>
                        this.#projects.gitAuthentication(candidateProjectId, creator),
                    resolveProfile: (candidateProfileId) =>
                        queryRigProfile(this.#tx(), candidateProfileId),
                    persistence: this,
                    folders: this.#folders,
                    slotStores: { entries: this.slots, applets: this.applets },
                    ...(projectId === undefined
                        ? {}
                        : { projectSecretIds: this.#projectSecrets(projectId) }),
                    request: resolved.request,
                    scope: resolved.scope,
                    ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
                    secretRegistry: this.#secrets,
                });
                session.emitCreatedEvent();
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

    deleteQueuedRun(sessionId: string, runId: string): void {
        sessionDeleteQueuedRun(this.#tx(), sessionId, runId);
    }

    acceptQueuedRun(
        input: Parameters<NonNullable<InMemorySessionPersistence["acceptQueuedRun"]>>[0],
    ): void {
        let globalEntry: GlobalEventQueueEntry | undefined;
        this.#transaction((tx) => {
            sessionAcceptQueuedRun(tx, {
                ...input,
                now: input.submittedAt,
                sessionId: input.event.sessionId,
            });
            if (this.#globalEventQueue.durable) {
                globalEntry = this.#globalEventQueue.append(input.event, tx);
            }
        });
        this.#precommittedGlobalEvents.set(input.event.id, globalEntry ?? null);
    }

    failQueuedRun(
        input: Parameters<NonNullable<InMemorySessionPersistence["failQueuedRun"]>>[0],
    ): void {
        let globalEntry: GlobalEventQueueEntry | undefined;
        this.#transaction((tx) => {
            sessionFailQueuedRun(tx, {
                ...input,
                now: this.#now(),
                sessionId: input.event.sessionId,
            });
            if (this.#globalEventQueue.durable) {
                globalEntry = this.#globalEventQueue.append(input.event, tx);
            }
        });
        this.#precommittedGlobalEvents.set(input.event.id, globalEntry ?? null);
    }

    get(sessionId: string): InMemorySession | undefined {
        const existingReference = this.#sessions.get(sessionId);
        const existing = existingReference?.deref();
        if (existing !== undefined) {
            this.#notifySessionAccess(existing);
            return existing;
        }
        if (existingReference !== undefined) this.#sessions.delete(sessionId);

        const session = this.#loadSession(sessionId);
        if (session !== undefined) {
            this.#cacheSession(session);
            this.#notifySessionAccess(session);
        }
        return session;
    }

    attachment(sessionId: string, attachmentId: string) {
        return (
            this.get(sessionId)?.attachment(attachmentId) ??
            querySessionAttachment(this.#tx(), sessionId, attachmentId)
        );
    }

    findByAgentId(agentId: string): InMemorySession | undefined {
        const sessionId = querySessionIdByAgentId(this.#tx(), agentId);
        return sessionId === undefined ? undefined : this.get(sessionId);
    }

    get globalEventQueue(): GlobalEventQueue {
        return this.#globalEventQueue;
    }

    setDurableGlobalEventQueue(enabled: boolean): GlobalEventQueue {
        if (this.#globalEventQueue.durable === enabled) return this.#globalEventQueue;
        this.#globalEventQueue.deactivate();
        this.#globalEventQueue = enabled
            ? new PersistentGlobalEventQueue(this.#database, { resetStream: true })
            : new InMemoryGlobalEventQueue();
        return this.#globalEventQueue;
    }

    insertQueuedRun(sessionId: string, run: PersistedQueuedRun): void {
        sessionSaveQueuedRun(this.#tx(), sessionId, run, this.#now());
    }

    startQueuedRun(
        input: Parameters<NonNullable<InMemorySessionPersistence["startQueuedRun"]>>[0],
    ): ReturnType<NonNullable<InMemorySessionPersistence["startQueuedRun"]>> {
        let globalEntry: GlobalEventQueueEntry | undefined;
        const drained = this.#transaction((tx) => {
            const sessionId = input.event.sessionId;
            sessionStartQueuedRun(tx, {
                activeSince: input.activeSince,
                event: input.event,
                now: this.#now(),
                runId: input.runId,
                sessionId,
            });
            if (this.#globalEventQueue.durable) {
                globalEntry = this.#globalEventQueue.append(input.event, tx);
            }
            return sessionDrainPendingContextMessages(tx, sessionId, input.regularMessageIds);
        });
        this.#precommittedGlobalEvents.set(input.event.id, globalEntry ?? null);
        return drained;
    }

    insertPendingContextMessage(sessionId: string, pending: PersistedPendingContextMessage): void {
        sessionSavePendingContextMessage(this.#tx(), sessionId, pending, this.#now());
    }

    drainPendingContextMessages(
        sessionId: string,
        messageIds?: readonly string[],
    ): readonly PersistedPendingContextMessage[] {
        return sessionDrainPendingContextMessages(this.#tx(), sessionId, messageIds);
    }

    list(options: { limit?: number } = {}): readonly SessionSummary[] {
        return this.#listSessions(false, options);
    }

    listActive(options: { limit?: number } = {}): readonly SessionSummary[] {
        return this.#listSessions(true, options);
    }

    #listSessions(activeOnly: boolean, options: { limit?: number }): readonly SessionSummary[] {
        const summaries = querySessionSummaries(this.#tx(), activeOnly, options);
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

    listExternalToolCalls(
        options: { limit?: number; status?: ExternalToolCall["status"] } = {},
    ): readonly ExternalToolCall[] {
        return queryExternalToolCalls(this.#tx(), options);
    }

    listDurableUserInputs(): readonly DurableUserInputCall[] {
        return queryDurableUserInputs(this.#tx());
    }

    listSubagents(parentSessionId: string): readonly SubagentSummary[] {
        return querySubagentSummaries(this.#tx(), parentSessionId);
    }

    queryAgentTreeUsage(sessionId: string) {
        return queryPersistedAgentTreeUsage(this.#tx(), sessionId);
    }

    timeline(request: GetTimelineRequest): readonly TimelineAgent[] {
        // One consistent read: the agents and their events must describe the
        // same moment, or a run that ended between the two queries would be
        // charted as though it never stopped.
        return inTx(this.#tx(), (tx) => {
            const agents = queryTimelineAgents(tx, request.scope, request.includeArchived ?? false);
            const events = queryTimelineEvents(
                tx,
                agents.map((agent) => agent.sessionId),
            );
            return buildTimeline(agents, events, {
                ...(request.since === undefined ? {} : { since: request.since }),
            });
        });
    }

    listSecrets(): readonly SecretSummary[] {
        return this.#secrets.references();
    }

    getProject(projectId: string): Project | undefined {
        return this.#projects.getProject(projectId);
    }

    applyGitFacts(
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): void {
        this.#projects.applyGitFacts(target, facts);
    }

    /**
     * Reports a Git change to the live sessions running in that directory.
     *
     * Only cached sessions are told: a session nobody is holding has no attached
     * client to inform, and reads current Git state when it is next loaded.
     */
    applyGitSnapshot(
        target: { projectId: string; workspaceId?: string },
        git: GitChangeSnapshot,
    ): void {
        for (const session of this.#cachedSessions()) {
            const identity = session.projectIdentity();
            if (identity === undefined) continue;
            if (identity.projectId !== target.projectId) continue;
            if (identity.workspaceId !== target.workspaceId) continue;
            session.recordGitState(git);
        }
    }

    listFolders(): readonly Folder[] {
        return this.#folders.listFolders();
    }

    folderCatalog() {
        return this.#folders.folderCatalog();
    }

    getFolder(folderId: string): Folder | undefined {
        return this.#folders.getFolder(folderId);
    }

    createFolder(request: CreateFolderRequest): Folder {
        return this.#folders.createFolder(request);
    }

    updateFolder(
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Folder | undefined {
        return this.#folders.updateFolder(folderId, request, expectedVersion);
    }

    moveFolder(
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Folder | undefined {
        return this.#folders.moveFolder(folderId, request, expectedVersion);
    }

    archiveFolder(
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Folder | undefined {
        return this.#folders.archiveFolder(folderId, expectedVersion, mutationId);
    }

    setSessionFolder(
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): InMemorySession | undefined {
        this.#assertAcceptingMutations();
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        session.fileIntoFolder(folderId, afterId, mutationId);
        return session;
    }

    sessionScopeMutationApplied(sessionId: string, mutationId: string): boolean {
        return this.#folders.sessionScopeMutationApplied(sessionId, mutationId);
    }

    listProjects(): readonly Project[] {
        return this.#projects.listProjects();
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
                instanceId: this.#localInstanceId,
                profileId: request.identity,
            },
        });
    }

    getWorkspace(projectId: string, workspaceId: string): ProjectWorkspace | undefined {
        return this.#projects.getWorkspace(projectId, workspaceId);
    }

    listWorkspaces(projectId?: string): readonly ProjectWorkspace[] {
        return this.#projects.listWorkspaces(projectId);
    }

    renameProject(
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Project | undefined {
        return this.#projects.renameProject(projectId, name, expectedVersion, mutationId);
    }

    queryProjectSettings(cwd: string): ProjectSessionSettings | undefined {
        return this.#projects.queryProjectSettings(cwd);
    }

    setProjectSettings(
        projectId: string,
        settings: ProjectSettingsUpdate,
        expectedVersion?: number,
        mutationId?: string,
    ): Project | undefined {
        return this.#projects.setProjectSettings(projectId, settings, expectedVersion, mutationId);
    }

    refreshProject(projectId: string): Project | undefined {
        return this.#projects.refreshProject(projectId);
    }

    reorderProject(
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Project | undefined {
        return this.#projects.reorderProject(projectId, request, expectedVersion);
    }

    reorderSession(sessionId: string, request: ReorderRequest): InMemorySession | undefined {
        this.#assertAcceptingMutations();
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        if (session.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        const snapshot = session.snapshot();
        this.#transaction(() => {
            session.setOrderKey(
                orderKeyAfter(this.#sessionOrderItems(snapshot.scope), sessionId, request.afterId),
            );
        });
        return session;
    }

    reorderWorkspace(
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): ProjectWorkspace | undefined {
        return this.#projects.reorderWorkspace(projectId, workspaceId, request, expectedVersion);
    }

    renameWorkspace(
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): ProjectWorkspace | undefined {
        return this.#projects.renameWorkspace(
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
        const session = this.get(sessionId);
        if (session === undefined) return false;
        const snapshot = session.snapshot();
        if (
            snapshot.ownerInstanceId !== creator.instanceId ||
            snapshot.profileId !== creator.profileId
        ) {
            throw new Error("That session belongs to another human profile.");
        }
        if (snapshot.projectId === undefined) return false;
        const project = this.#projects.getProject(snapshot.projectId);
        if (project?.remoteSource?.kind !== "github") return false;
        await this.#projects.refreshGitCredential(snapshot.projectId, creator, githubToken);
        session.refreshGitCommandSecret();
        return true;
    }

    archiveProject(projectId: string, expectedVersion?: number): Promise<Project | undefined> {
        const archive = () => this.#archiveProject(projectId, expectedVersion);
        return this.#taskDrain?.run(archive) ?? archive();
    }

    unarchiveProject(projectId: string): Project | undefined {
        return this.#projects.unarchiveProject(projectId);
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
        this.#transaction(() => {
            project = this.#projects.archiveProject(projectId, expectedVersion);
            if (project === undefined) return;
            const rootSessionIds = queryRootSessionIdsForProject(this.#tx(), projectId);
            for (const sessionId of rootSessionIds) this.get(sessionId)?.setArchived(true);
            archiving = this.#projects.listWorkspaces(projectId).flatMap((workspace) => {
                if (workspace.status === "archived" || workspace.status === "archiving") {
                    return [];
                }
                const begun = this.#projects.beginWorkspaceArchive(projectId, workspace.id);
                if (begun === undefined || begun.status === "archived") return [];
                return [workspace.id];
            });
        });
        if (project === undefined) return undefined;
        // Every workspace is logically archived above; its sessions follow one transaction at a
        // time so no session teardown runs while the project archival holds the write lock.
        const workspaces = archiving.map((workspaceId) => ({
            cleanup: this.#archiveWorkspaceSessions(workspaceId),
            workspaceId,
        }));
        // All logical state is committed before physical cleanup yields.
        await this.remoteTerminals.closeProject(projectId);
        for (const workspace of workspaces) {
            await this.#completeWorkspaceArchive(
                projectId,
                workspace.workspaceId,
                workspace.cleanup,
            );
        }
        return this.getProject(projectId);
    }

    archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        return this.#archiveWorkspace(projectId, workspaceId, expectedVersion);
    }

    #archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        // The workspace becomes "archiving" in its own transaction, before any session is touched.
        // That decision is what makes the rest resumable: a daemon that dies partway through finds
        // the workspace still archiving on the next start and runs the remaining sessions.
        const workspace = this.#transaction(() =>
            this.#projects.beginWorkspaceArchive(projectId, workspaceId, expectedVersion),
        );
        if (workspace === undefined || workspace.status === "archived") {
            return Promise.resolve(workspace);
        }
        const cleanup = this.#archiveWorkspaceSessions(workspaceId);
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
     * Archives the workspace's sessions one at a time, each in its own transaction, and starts each
     * session's teardown only once that transaction has committed. Nothing but database work runs
     * under the write lock, so an observer that reaches the database from a session callback cannot
     * deadlock against an archival that is still open.
     */
    #archiveWorkspaceSessions(workspaceId: string): Promise<void>[] {
        const cleanup: Promise<void>[] = [];
        // Sessions cannot join a workspace that is already archiving, so this list only shrinks.
        const pending = this.#transaction(() =>
            queryUnarchivedSessionIdsForWorkspace(this.#tx(), workspaceId),
        );
        for (const sessionId of pending) {
            const teardown = this.#transaction(() =>
                this.get(sessionId)?.archiveForWorkspace(workspaceId),
            );
            if (teardown !== undefined) cleanup.push(teardown());
        }
        return cleanup;
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
        return this.#projects.removeArchivedWorkspace(projectId, workspaceId);
    }

    setProjectAvatar(
        projectId: string,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        return this.#projects.setAvatar(projectId, "user", bytes, expectedVersion);
    }

    clearProjectAvatar(projectId: string): Project | undefined {
        return this.#projects.clearAvatar(projectId);
    }

    getProjectAvatar(hash: string): Promise<ProjectAvatarAsset | undefined> {
        return this.#projects.avatarAsset(hash);
    }

    registerSecret(request: RegisterSecretRequest): SecretSummary {
        const candidate = new SecretRegistry([request]);
        secretRegister(this.#tx(), request);
        this.#secrets.register(request);
        return candidate.reference(request.id);
    }

    registerSpecialSecret(request: SpecialSecretRegistration): SecretSummary {
        this.#secrets.register(request);
        this.#projects.retryRemoteProjects(request.kind);
        return this.#secrets.reference(request.kind);
    }

    resolveSpecialSecret(kind: SpecialSecretKind): NodeJS.ProcessEnv {
        return this.#secrets.resolveSpecial(kind);
    }

    unregisterSecret(secretId: string): boolean {
        const secret = this.#secrets.references().find((candidate) => candidate.id === secretId);
        if (secret === undefined || secret.kind !== undefined) return false;
        secretUnregister(this.#tx(), secretId);
        this.#secrets.unregister(secretId);
        for (const session of this.#cachedSessions()) {
            session.detachSecret(secretId, { scope: "project" });
            session.detachSecret(secretId, { scope: "session" });
        }
        return true;
    }

    unregisterSpecialSecret(kind: SpecialSecretKind): boolean {
        return this.#secrets.unregisterSpecial(kind);
    }

    updateSecret(secretId: string, request: UpdateSecretRequest): SecretSummary | undefined {
        const updated = this.#secrets.updatedRegistration(secretId, request);
        if (updated === undefined) return undefined;
        secretRegister(this.#tx(), updated);
        this.#secrets.register(updated);
        return this.#secrets.reference(secretId);
    }

    #listSubagentSessionsByRoot(rootSessionId: string): readonly InMemorySession[] {
        return querySubagentSessionIdsByRoot(this.#tx(), rootSessionId)
            .map((sessionId) => this.get(sessionId))
            .filter((session): session is InMemorySession => session !== undefined);
    }

    repairInterruptedSessions(reason: SessionInterruption["reason"]): void {
        for (const { activeRunId, sessionId } of queryInterruptedSessionCandidates(this.#tx())) {
            if (
                activeRunId !== undefined &&
                this.#reconcileTerminalRunState(sessionId, activeRunId)
            ) {
                continue;
            }
            const session = this.get(sessionId);
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
                session.workspaceReadinessChanged();
                continue;
            }
            if (session.hasDurableToolRun()) {
                session.resumeDurableToolRun();
                continue;
            }
            if (session.isSubagent() && state.status === "suspended") {
                const message =
                    "The subagent stopped working because the local server restarted before its suspended run finished.";
                session.markSuspendedAfterRestart(message, runId);
                const parentSessionId = session.agentMetadata().parentSessionId;
                const parent =
                    parentSessionId === undefined ? undefined : this.get(parentSessionId);
                this.#agentManager.recordChanged(session);
                if (parent !== undefined) {
                    const subagent = session.subagentSummary();
                    const path = this.#agentManager.inspect(parent.id, subagent.agentId).path;
                    parent.recordSubagentStoppedAfterRestart(subagent, path);
                }
                continue;
            }
            session.markInterrupted({
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
                this.#agentManager.recordChanged(session);
            }
        }
    }

    #reconcileTerminalRunState(sessionId: string, runId: string): boolean {
        const event = queryTerminalRunEvent(this.#tx(), sessionId, runId);
        if (event === undefined) return false;
        sessionReconcileTerminalRun(this.#tx(), {
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
        const cleanup = [
            ...[...closingSessions].map((session) => session.beginShutdown()),
            this.remoteTerminals.close(),
        ];
        let repairError: unknown;
        try {
            this.repairInterruptedSessions(reason);
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

    saveSession(state: PersistedSessionState): void {
        validOwnerInstanceId(state.ownerInstanceId);
        const contextMessages =
            state.contextMessages ??
            state.messages
                .filter((message) => !message.isPartial)
                .sort((left, right) => left.position - right.position)
                .map((message) => message.message);
        sessionSave(this.#tx(), state, {
            contextMessages,
            now: this.#now(),
        });
    }

    setWorkspaceTransferState(
        input: Parameters<NonNullable<InMemorySessionPersistence["setWorkspaceTransferState"]>>[0],
    ): void {
        sessionSetWorkspaceTransferState(this.#tx(), { ...input, now: this.#now() });
    }

    transferWorkspace(input: {
        contextMessages: readonly Message[];
        cwd: string;
        sessionId: string;
        state: Parameters<typeof sessionTransferWorkspace>[1]["state"];
        projectId: string;
        workspaceId: string;
    }): string {
        const scope: SessionScope = {
            kind: "workspace",
            projectId: input.projectId,
            workspaceId: input.workspaceId,
        };
        const orderKey = this.#newLastSessionOrderKey(scope);
        sessionTransferWorkspace(this.#tx(), { ...input, now: this.#now(), orderKey });
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
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        return executeSessionWorkspaceTransfer({
            hasAttachedSessions: (workspaceId) =>
                queryWorkspaceHasAttachedSessions(this.#tx(), workspaceId),
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

    query<T>(operation: (tx: TX) => T): T {
        this.#assertOpen();
        return operation(this.#tx());
    }

    transaction<T>(operation: (tx: TX) => T): T {
        return this.#transaction(operation);
    }

    #assertAcceptingMutations(): void {
        if (this.#taskDrain?.closing === true) {
            throw new Error("The local daemon is shutting down.");
        }
    }

    upsertMessage(sessionId: string, message: PersistedSessionMessage): void {
        sessionSaveMessage(this.#tx(), sessionId, message, this.#now());
    }

    loadTranscriptPage(
        sessionId: string,
        turnLimit: number,
        before?: string,
    ): SessionTranscriptWindow | undefined {
        const page = querySessionTranscriptPage(this.#tx(), sessionId, turnLimit, before);
        if (page === undefined) return undefined;
        const firstPosition = page.messages[0]?.position;
        const hasEarlier =
            firstPosition !== undefined &&
            querySessionHasEarlierTranscriptMessage(this.#tx(), sessionId, firstPosition);
        return this.#transcriptWindowForMessages(
            sessionId,
            page.messages,
            turnLimit,
            !hasEarlier,
            page.noticesTruncated,
        );
    }

    loadTranscriptSince(
        sessionId: string,
        turnLimit: number,
        after: EventId,
    ): SessionTranscriptWindow | undefined {
        const range = querySessionTranscriptSince(this.#tx(), sessionId, turnLimit, after);
        if (range === undefined) return undefined;
        const lastPosition = range.messages.at(-1)?.position;
        const hasLater =
            lastPosition !== undefined &&
            querySessionHasLaterTranscriptMessage(this.#tx(), sessionId, lastPosition);
        return this.#transcriptWindowForMessages(
            sessionId,
            range.messages,
            turnLimit,
            !hasLater,
            range.truncated,
        );
    }

    upsertExternalToolCall(call: ExternalToolCall): void {
        externalToolCallSave(this.#tx(), call);
    }

    handoffDurablePermissionToExternalTool(
        externalCall: ExternalToolCall,
        permissionCall: DurableUserInputCall,
    ): void {
        durablePermissionHandoff(this.#tx(), externalCall, permissionCall);
    }

    upsertDurableUserInput(call: DurableUserInputCall): void {
        durableUserInputSave(this.#tx(), call);
    }

    upsertDurableWait(wait: DurableWait): void {
        durableWaitSave(this.#tx(), wait);
    }

    upsertScheduledMessage(message: ScheduledMessage): void {
        scheduledMessageSave(this.#tx(), message);
    }

    scheduledMessageChanged(): void {
        this.#afterTransactionCommit(() => this.#armScheduledMessageTimer());
    }

    pruneExternalToolCalls(sessionId: string, retain: number): void {
        externalToolCallPrune(this.#tx(), sessionId, retain);
    }

    pruneDurableUserInputs(sessionId: string, retain: number): void {
        durableUserInputPrune(this.#tx(), sessionId, retain);
    }

    pruneDurableWaits(sessionId: string, retain: number): void {
        durableWaitPrune(this.#tx(), sessionId, retain);
    }

    pruneScheduledMessages(sessionId: string, retain: number): readonly string[] {
        return scheduledMessagePrune(this.#tx(), sessionId, retain);
    }

    #armScheduledMessageTimer(): void {
        if (!this.#client.open) return;
        if (this.#scheduledMessageTimer !== undefined) clearTimeout(this.#scheduledMessageTimer);
        const next = queryNextPendingScheduledMessage(this.#tx());
        if (next === undefined) {
            this.#scheduledMessageTimer = undefined;
            return;
        }
        const delay = Math.min(MAX_SCHEDULE_TIMER_DELAY_MS, Math.max(0, next.dueAt - this.#now()));
        this.#scheduledMessageTimer = setTimeout(() => {
            this.#scheduledMessageTimer = undefined;
            this.#deliverDueScheduledMessages();
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
    archiveExpiredUnsortedSessions(): boolean {
        if (!this.#client.open) return false;
        const unsortedBefore = this.#now() - UNSORTED_SESSION_ARCHIVE_AFTER_MS;
        const deadline = Date.now() + UNSORTED_SWEEP_MAX_MS;
        let archived = 0;
        while (archived < UNSORTED_SWEEP_MAX_SESSIONS && Date.now() <= deadline) {
            const expired = queryExpiredUnsortedSessions(
                this.#tx(),
                unsortedBefore,
                Math.min(UNSORTED_SWEEP_LIMIT, UNSORTED_SWEEP_MAX_SESSIONS - archived),
            );
            if (expired.length === 0) return false;
            for (const sessionId of expired) {
                if (!this.#client.open) return false;
                const session = this.get(sessionId);
                if (session !== undefined) {
                    // An Unsorted root may be idle while one of its background agents is still
                    // running. Expiry is terminal for the whole retained tree, just like archiving
                    // the folder that owns one, so no hidden descendant keeps acting after the
                    // root disappears from Unsorted.
                    void session.recordFolderArchived().catch(rethrowDatabaseFailure);
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

    #sweepUnsortedSessions(): void {
        try {
            if (this.archiveExpiredUnsortedSessions()) this.#scheduleUnsortedSweep();
        } catch (error) {
            // Sweeping runs on its own, outside any request. A database that could not answer is
            // still fatal; one chat that refused to be put away must not take the daemon down.
            if (!this.#client.open) return;
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #scheduleUnsortedSweep(): void {
        if (!this.#client.open || this.#unsortedSweepFollowup !== undefined) return;
        this.#unsortedSweepFollowup = setImmediate(() => {
            this.#unsortedSweepFollowup = undefined;
            this.#sweepUnsortedSessions();
        });
        this.#unsortedSweepFollowup.unref();
    }

    pruneStaleToolResults(): boolean {
        if (!this.#client.open || this.#toolResultRetentionMs === undefined) return false;
        const before = this.#now() - this.#toolResultRetentionMs;
        const deadline = Date.now() + TOOL_RESULT_SWEEP_MAX_MS;
        let scanned = 0;
        while (scanned < TOOL_RESULT_SWEEP_MAX_SCANNED_MESSAGES && Date.now() <= deadline) {
            const page = sessionPruneToolResults(this.#tx(), {
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

    #sweepToolResults(): void {
        try {
            if (this.pruneStaleToolResults()) this.#scheduleToolResultSweep();
        } catch (error) {
            if (!this.#client.open) return;
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #scheduleToolResultSweep(): void {
        if (!this.#client.open || this.#toolResultSweepFollowup !== undefined) return;
        this.#toolResultSweepFollowup = setImmediate(() => {
            this.#toolResultSweepFollowup = undefined;
            this.#sweepToolResults();
        });
        this.#toolResultSweepFollowup.unref();
    }

    #deliverDueScheduledMessages(): void {
        for (;;) {
            const next = queryNextPendingScheduledMessage(this.#tx());
            if (next === undefined || next.dueAt > this.#now()) break;
            const sender = this.get(next.senderSessionId);
            if (sender === undefined) {
                throw new Error("The sender of a scheduled message no longer exists.");
            }
            sender.deliverScheduledMessage(next.id);
        }
        this.#armScheduledMessageTimer();
    }

    #appendEvent(event: SessionEvent): void {
        if (isLiveOnlySessionEvent(event)) {
            sessionAdvanceEventCursor(this.#tx(), event.sessionId, event.id, this.#now());
            this.#afterTransactionCommit(() => {
                this.#publishLiveStream(event);
                this.#publishGlobalEvent(event);
                this.#notifySessionEvent(event);
            });
            return;
        }
        const eventFacts = sessionEventFacts(event);
        const precommitted = this.#precommittedGlobalEvents.has(event.id);
        let globalEntry = this.#precommittedGlobalEvents.get(event.id) ?? undefined;
        this.#precommittedGlobalEvents.delete(event.id);
        let inserted = false;
        this.#transaction((tx) => {
            inserted = sessionAppendEvent(tx, event, eventFacts, this.#now()) === "inserted";
            if (!precommitted && inserted && this.#globalEventQueue.durable) {
                globalEntry = this.#globalEventQueue.append(event, tx);
            }
        });
        // The live stream carries this event whether or not the durable log
        // keeps it, but never before the row it describes is committed.
        this.#afterTransactionCommit(() => this.#publishLiveStream(event));
        if (this.#globalEventQueue.durable && globalEntry !== undefined) {
            const queue = this.#globalEventQueue;
            this.#afterTransactionCommit(() => queue.publish(globalEntry!));
        } else if (
            (inserted || precommitted) &&
            !this.#globalEventQueue.durable &&
            shouldPublishGlobalEvent(event)
        ) {
            const queue = this.#globalEventQueue;
            this.#afterTransactionCommit(() => {
                const entry = queue.append(event);
                if (entry !== undefined) queue.publish(entry);
            });
        }
        this.#afterTransactionCommit(() => this.#notifySessionEvent(event));
    }

    /**
     * Puts an event on the ephemeral stream every local client follows.
     *
     * Session events arrive here through `#appendEvent`, which has already done
     * this, so only the rest are forwarded from `#publishGlobalEvent`.
     */
    #publishLiveStream(event: GlobalEvent): void {
        const queue = this.liveEvents;
        this.#afterTransactionCommit(() => queue.publish(event));
    }

    #projectEvent(event: GlobalEvent): void {
        this.#publishGlobalEvent(event);
        if (event.type !== "workspace_created" && event.type !== "workspace_updated") return;
        if (event.data.workspace.status === "initializing") return;
        this.#afterTransactionCommit(() => {
            this.#workspaceReadyWaiters.changed(event.projectId, event.workspaceId);
            this.#workspaceReadinessChanged(event.workspaceId);
        });
    }

    #workspaceReadinessChanged(workspaceId: string): void {
        for (const sessionId of queryWorkspaceQueuedSessionIds(this.#tx(), workspaceId)) {
            this.get(sessionId)?.workspaceReadinessChanged();
        }
    }

    #publishGlobalEvent(event: GlobalEvent): void {
        if (!("sessionId" in event)) this.#publishLiveStream(event);
        if (isLiveGlobalEvent(event)) {
            const queue = this.#globalEventQueue;
            this.#afterTransactionCommit(() => {
                queue.publishLive(event);
            });
            return;
        }
        if (!shouldPublishGlobalEvent(event)) return;
        const queue = this.#globalEventQueue;
        if (!queue.durable) {
            this.#afterTransactionCommit(() => {
                const entry = queue.append(event);
                if (entry !== undefined) queue.publish(entry);
            });
            return;
        }
        const entry = queue.append(event, this.#tx());
        if (entry !== undefined) {
            this.#afterTransactionCommit(() => queue.publish(entry));
        }
    }

    #notifySessionAccess(session: InMemorySession): void {
        // Observers own their own database connections, and SQLite is synchronous. One that writes
        // while this store still holds the write lock would wait for a transaction that cannot
        // commit until the observer returns, so every notification waits for the commit.
        this.#afterTransactionCommit(() => {
            try {
                this.#onSessionAccess?.(session);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                // External synchronization must never interrupt local session access.
            }
        });
    }

    #notifySessionEvent(event: SessionEvent): void {
        try {
            this.#onSessionEvent?.(event, this.#sessions.get(event.sessionId)?.deref());
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            // The event is already durable; optional observers cannot roll it back.
        }
    }

    #loadSecretRegistrations(): void {
        const loaded = querySecretRegistrations(this.#tx());
        for (const registration of loaded.registrations) this.#secrets.register(registration);
        for (const variable of loaded.environmentVariables) {
            this.#secrets.rememberEnvironmentVariables(variable.secretId, [variable.name]);
        }
    }

    #inheritWorkspaceName(
        metadata: Parameters<NonNullable<InMemorySessionOptions["onInitialTitle"]>>[0],
    ): void {
        const firstSessionId = queryFirstRootSessionIdForWorkspace(
            this.#tx(),
            metadata.projectId,
            metadata.workspaceId,
        );
        if (firstSessionId !== metadata.sessionId) return;
        this.#projects.inheritWorkspaceName(
            metadata.projectId,
            metadata.workspaceId,
            metadata.title,
        );
    }

    #loadSession(sessionId: string): InMemorySession | undefined {
        const loaded = querySessionRestore(this.#tx(), sessionId);
        if (loaded === undefined) return undefined;
        const ownerInstanceId = validOwnerInstanceId(loaded.restore.ownerInstanceId);
        const folderPath =
            loaded.restore.scope.kind === "folder"
                ? this.#folders.folderStoragePath(loaded.restore.scope.folderId)
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
        return new InMemorySession({
            presence: this.presence,
            agentManager: this.#agentManager,
            workspaceFeatures: this.#workspaceFeatures,
            workspaceRunReadiness: (target) => workspaceRunReadiness(this.#projects, target),
            createEventId: createEventIdFactory(
                loaded.lastEventId === undefined ? {} : { after: loaded.lastEventId },
            ),
            ...(this.#createRuntime === undefined ? {} : { createRuntime: this.#createRuntime }),
            deferEventNotification: (notify) => this.#afterTransactionCommit(notify),
            events: querySessionEvents(this.#tx(), sessionId, RESTORED_SESSION_EVENT_LIMIT),
            ...(loaded.lastEventId === undefined ? {} : { lastEventId: loaded.lastEventId }),
            modelCatalog: this.#modelCatalogFor(ownerInstanceId),
            now: this.#now,
            onInitialTitle: (metadata) => this.#inheritWorkspaceName(metadata),
            ...(this.#mcpToolProvider === undefined
                ? {}
                : { mcpToolProvider: this.#mcpToolProvider }),
            onAppendEvent: (event) => this.#appendEvent(event),
            persistence: this,
            folders: this.#folders,
            slotStores: { entries: this.slots, applets: this.applets },
            ...(loaded.restore.scope.kind === "project" || loaded.restore.scope.kind === "workspace"
                ? {
                      projectSecretIds: queryProjectSecretIds(
                          this.#tx(),
                          loaded.restore.scope.projectId,
                      ),
                  }
                : {}),
            ownerInstanceId,
            resolveGitAuthentication: (projectId, creator) =>
                this.#projects.gitAuthentication(projectId, creator),
            resolveProfile: (profileId) => queryRigProfile(this.#tx(), profileId),
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
        return ownerInstanceId === this.#localInstanceId
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

    #newLastSessionOrderKey(scope: SessionScope): string {
        const items = this.#sessionOrderItems(scope);
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

    #sessionOrderItems(scope: SessionScope): { id: string; orderKey: string }[] {
        return querySessionOrderItems(this.#tx(), scope);
    }

    #transcriptWindowForMessages(
        sessionId: string,
        messages: readonly PersistedSessionMessage[],
        turnLimit: number,
        complete: boolean,
        noticesTruncated: boolean,
    ): SessionTranscriptWindow | undefined {
        const events = querySessionTranscriptEvents(this.#tx(), sessionId, messages);
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
    remoteTerminalDocker(scope: RemoteTerminalScope): DockerExecutionConfig | undefined {
        try {
            return this.#remoteTerminalContext(scope).docker;
        } catch {
            return undefined;
        }
    }

    #remoteTerminalContext(scope: RemoteTerminalScope): ProjectRemoteTerminalContext {
        const project = this.#projects.getProject(scope.projectId);
        if (project === undefined) throw new Error("Project not found.");
        if (project.archivedAt !== undefined) {
            throw new Error("Archived projects cannot open terminals.");
        }
        const workspace =
            scope.workspaceId === undefined
                ? undefined
                : this.#projects.getWorkspace(scope.projectId, scope.workspaceId);
        if (scope.workspaceId !== undefined && workspace === undefined) {
            throw new Error("Workspace not found.");
        }
        if (
            workspace !== undefined &&
            workspaceRunReadiness(this.#projects, {
                cwd: workspace.path,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
            }).state !== "ready"
        ) {
            throw new Error("Only ready, available workspaces can open terminals.");
        }
        const cwd = workspace?.path ?? project.path;
        const docker = configureSessionRequest({ cwd }, this.#defaultDocker, () =>
            this.#projects.queryProjectSettings(cwd),
        ).docker;
        return {
            cwd,
            ...(docker === undefined ? {} : { docker }),
        };
    }

    #projectSecrets(projectId: string): readonly string[] {
        return queryProjectSecretIds(this.#tx(), projectId);
    }

    async #recoverProjectWorkspaces(): Promise<void> {
        // Each step resumes after an await, by which point the store may have been closed. Asking a
        // connection that is already gone would fail for a reason that is not a database fault.
        if (!this.#client.open) return;
        for (const workspace of this.#projects.listWorkspaces()) {
            if (workspace.status !== "archiving") continue;
            if (!this.#client.open) return;
            await this.#archiveWorkspace(workspace.projectId, workspace.id);
        }
        if (!this.#client.open) return;
        await this.#projects.reconcileInitializingWorkspaces();
        if (!this.#client.open) return;
        // Presence and Git facts are enrichment, so they run only after archival recovery, which is
        // user-visible correctness.
        await this.#projects.reconcileGitFacts();
    }

    #repairInterruptedTitleGenerations(): void {
        sessionRepairInterruptedTitles(this.#tx(), this.#now());
    }

    #tx(): TX {
        this.#assertOpen();
        return this.#activeTransaction ?? this.#database;
    }

    /**
     * Background work outlives the store that started it, so a session can still try to save after
     * shutdown closed the connection. Asking a closed connection reports that it is not open, which
     * is indistinguishable from a real fault once it escapes. Refusing here keeps a deliberate
     * shutdown from being mistaken for a database that could not answer.
     */
    #assertOpen(): void {
        if (this.#client.open) return;
        throw new Error("The session database is closed.");
    }

    #transaction<T>(body: (tx: TX) => T): T {
        if (this.#activeTransaction !== undefined) return body(this.#activeTransaction);
        this.#assertOpen();
        this.#transactionCommitCallbacks = [];
        try {
            const value = inTx(this.#database, (tx) => {
                this.#activeTransaction = tx;
                try {
                    return body(tx);
                } finally {
                    this.#activeTransaction = undefined;
                }
            });
            const callbacks = this.#transactionCommitCallbacks;
            this.#transactionCommitCallbacks = undefined;
            for (const callback of callbacks) {
                try {
                    callback();
                } catch (error) {
                    if (isDatabaseFailure(error)) throw error;
                    // The durable transaction already committed; observers are best effort.
                }
            }
            return value;
        } catch (error) {
            this.#activeTransaction = undefined;
            this.#transactionCommitCallbacks = undefined;
            throw error;
        }
    }

    #afterTransactionCommit(callback: () => void): void {
        if (this.#transactionCommitCallbacks !== undefined) {
            this.#transactionCommitCallbacks.push(callback);
            return;
        }
        callback();
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
