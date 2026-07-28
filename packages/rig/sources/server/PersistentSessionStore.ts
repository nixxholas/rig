import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createEventIdFactory, isLiveGlobalEvent } from "../protocol/index.js";
import type {
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateProjectWorkspaceRequest,
    CreateSessionRequest,
    EventId,
    GitChangeSnapshot,
    GitRepositoryFacts,
    ModelCatalog,
    Project,
    ProjectWorkspace,
    ReorderRequest,
    GlobalEvent,
    RegisterSecretRequest,
    SecretSummary,
    SessionEvent,
    SessionAgentMetadata,
    SessionInterruption,
    SessionSummary,
    SessionTranscriptWindow,
    SessionTokenCount,
    SessionUnreadReason,
    SubagentSummary,
    SessionTitleStatus,
} from "../protocol/index.js";
import type { Message } from "../agent/types.js";
import type { Model, ServiceTier, Usage } from "@slopus/rig-execution";
import type { SessionGoal } from "../goals/index.js";
import { parsePermissionMode } from "../permissions/index.js";
import {
    InMemorySession,
    type InMemorySessionOptions,
    type InMemorySessionPersistence,
    type PersistedQueuedRun,
    type PersistedSessionMessage,
    type PersistedSessionState,
    type PersistedWorkflowRun,
} from "./InMemorySession.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import { createModelCatalog } from "./createModelCatalog.js";
import type { GlobalEventQueue } from "./GlobalEventQueue.js";
import { PersistentGlobalEventQueue } from "./PersistentGlobalEventQueue.js";
import type { SessionStore } from "./SessionStore.js";
import type { McpToolProvider } from "../mcp/index.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { summarizeDockerExecution } from "../execution/index.js";
import type { TaskDrain } from "./TrackedTaskDrain.js";
import type { SessionUsageSummary } from "./sessionUsage/index.js";
import { isLiveOnlySessionEvent } from "./isLiveOnlySessionEvent.js";
import { SecretRegistry, type SecretRegistration } from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import { initializeSessionDatabase } from "./initializeSessionDatabase.js";
import type { ExternalToolCall, ExternalToolDefinition } from "../external-tools/index.js";
import type { DurableSkillDefinition } from "../external-skills/index.js";
import type { DurableUserInputCall } from "../user-input/index.js";
import { InMemoryGlobalEventQueue } from "./InMemoryGlobalEventQueue.js";
import { LiveGlobalEventQueue } from "./LiveGlobalEventQueue.js";
import {
    ProjectRepository,
    type ProjectAvatarAsset,
    type ProjectGitRunner,
} from "./ProjectRepository.js";
import { shouldPublishGlobalEvent } from "./shouldPublishGlobalEvent.js";
import { errorToMessage } from "../errorToMessage.js";
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

const RESTORED_SESSION_EVENT_LIMIT = 4_096;
const RESTORED_SESSION_MESSAGE_LIMIT = 256;

export interface PersistentSessionStoreOptions {
    createRuntime?: InMemorySessionOptions["createRuntime"];
    databasePath: string;
    durableGlobalEventQueue?: boolean;
    mcpToolProvider?: McpToolProvider;
    modelCatalog?: ModelCatalog;
    now?: () => number;
    onSessionAccess?: (session: InMemorySession) => void;
    onSessionEvent?: (event: SessionEvent, session: InMemorySession | undefined) => void;
    projectGit?: ProjectGitRunner;
    taskDrain?: TaskDrain;
    secrets?: readonly SecretRegistration[];
    homeDirectory?: string;
    stateDirectory?: string;
}

export class PersistentSessionStore implements SessionStore, InMemorySessionPersistence {
    #agentManager: AgentSessionManager;
    #createRuntime: InMemorySessionOptions["createRuntime"];
    readonly #createTerminalEventId = createEventIdFactory();
    #database: DatabaseSync;
    #modelCatalog: ModelCatalog;
    #mcpToolProvider: McpToolProvider | undefined;
    #now: () => number;
    #onSessionAccess: ((session: InMemorySession) => void) | undefined;
    #onSessionEvent:
        | ((event: SessionEvent, session: InMemorySession | undefined) => void)
        | undefined;
    #globalEventQueue: GlobalEventQueue;
    #projects: ProjectRepository;
    #secrets: SecretRegistry;
    #sessions = new Map<string, WeakRef<InMemorySession>>();
    #sessionFinalizer = new FinalizationRegistry<{
        id: string;
        reference: WeakRef<InMemorySession>;
    }>(({ id, reference }) => {
        if (this.#sessions.get(id) === reference) this.#sessions.delete(id);
    });
    #taskDrain: TaskDrain | undefined;
    #transactionCommitCallbacks: (() => void)[] | undefined;
    readonly liveEvents = new LiveGlobalEventQueue();
    readonly remoteTerminals: ProjectRemoteTerminalStore;

    constructor(options: PersistentSessionStoreOptions) {
        this.#secrets = new SecretRegistry();
        this.#modelCatalog = options.modelCatalog ?? createModelCatalog();
        this.#createRuntime = options.createRuntime;
        this.#mcpToolProvider = options.mcpToolProvider;
        this.#now = options.now ?? Date.now;
        this.#onSessionAccess = options.onSessionAccess;
        this.#onSessionEvent = options.onSessionEvent;
        this.#taskDrain = options.taskDrain;
        if (options.databasePath !== ":memory:") {
            mkdirSync(dirname(options.databasePath), { mode: 0o700, recursive: true });
        }
        this.#database = new DatabaseSync(options.databasePath, {
            enableForeignKeyConstraints: true,
            timeout: 5_000,
        });
        if (options.databasePath !== ":memory:") chmodSync(options.databasePath, 0o600);
        initializeSessionDatabase(this.#database);
        this.#loadSecretRegistrations();
        for (const secret of options.secrets ?? []) this.registerSecret(secret);
        this.#globalEventQueue =
            options.durableGlobalEventQueue === true
                ? new PersistentGlobalEventQueue(this.#database)
                : new InMemoryGlobalEventQueue();
        this.#projects = new ProjectRepository({
            database: this.#database,
            ...(options.projectGit === undefined ? {} : { git: options.projectGit }),
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (event) => this.#publishGlobalEvent(event),
            ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
            transaction: (body) => this.#transaction(body),
            ...(options.stateDirectory !== undefined
                ? { stateDirectory: options.stateDirectory }
                : options.databasePath === ":memory:"
                  ? {}
                  : { stateDirectory: dirname(options.databasePath) }),
        });
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
            repository: {
                createSubagent: (request, metadata, contextMessages) =>
                    this.#createSession(request, metadata, contextMessages),
                findByAgentId: (agentId) => this.findByAgentId(agentId),
                get: (sessionId) => this.get(sessionId),
                listByRoot: (rootSessionId) => this.#listSubagentSessionsByRoot(rootSessionId),
            },
            ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
        });
        this.#repairInterruptedTitleGenerations();
        this.repairInterruptedSessions("crash");
        const recover = () => this.#recoverProjectWorkspaces();
        const recovery = this.#taskDrain?.run(recover) ?? recover();
        void recovery.catch(() => undefined);
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
            const projectId = session.snapshot().projectId;
            this.#database
                .prepare(
                    "INSERT OR IGNORE INTO project_secret_attachments (project_id, secret_id) VALUES (?, ?)",
                )
                .run(projectId, secretId);
            for (const candidate of this.#cachedSessions()) {
                if (candidate.snapshot().projectId === projectId) {
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
        this.#transaction(() => {
            this.#database
                .prepare("DELETE FROM session_messages WHERE session_id = ?")
                .run(sessionId);
            this.#database.prepare("DELETE FROM session_turns WHERE session_id = ?").run(sessionId);
        });
    }

    deleteMessagesFrom(sessionId: string, position: number): void {
        this.#transaction(() => {
            this.#database
                .prepare("DELETE FROM session_messages WHERE session_id = ? AND position >= ?")
                .run(sessionId, position);
            this.#database.prepare("DELETE FROM session_turns WHERE session_id = ?").run(sessionId);
            this.#database
                .prepare(
                    `
                INSERT INTO session_turns (session_id, run_id, first_position)
                SELECT session_id, run_id, MIN(position)
                FROM session_messages
                WHERE session_id = ? AND run_id IS NOT NULL AND is_partial = 0
                GROUP BY session_id, run_id
                `,
                )
                .run(sessionId);
        });
    }

    close(): void {
        void this.remoteTerminals.close();
        this.#projects.close();
        this.liveEvents.close();
        this.#globalEventQueue.deactivate();
        this.#database.close();
    }

    create(request: CreateSessionRequest): InMemorySession {
        this.#assertAcceptingMutations();
        return this.#createSession(request);
    }

    createWithId(id: string, request: CreateSessionRequest): InMemorySession {
        this.#assertAcceptingMutations();
        const existing = this.get(id);
        return existing ?? this.#createSession(request, undefined, undefined, id);
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
            const projectId = session.snapshot().projectId;
            this.#database
                .prepare(
                    "DELETE FROM project_secret_attachments WHERE project_id = ? AND secret_id = ?",
                )
                .run(projectId, secretId);
            for (const candidate of this.#cachedSessions()) {
                if (candidate.snapshot().projectId === projectId) {
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
        const state = source.createForkState();
        const sourceSnapshot = source.snapshot();
        if (sourceSnapshot.workspaceId !== undefined) {
            const workspace = this.#projects.getWorkspace(
                sourceSnapshot.projectId,
                sourceSnapshot.workspaceId,
            );
            if (workspace?.status !== "ready") {
                throw new Error("A session in an unavailable workspace cannot be forked.");
            }
        }
        let session!: InMemorySession;
        this.#transaction(() => {
            session = new InMemorySession({
                agentManager: this.#agentManager,
                createEventId: createEventIdFactory(),
                ...(this.#createRuntime === undefined
                    ? {}
                    : { createRuntime: this.#createRuntime }),
                emitCreatedEvent: false,
                ...(targetSessionId === undefined ? {} : { id: targetSessionId }),
                modelCatalog: this.#modelCatalog,
                onInitialTitle: (metadata) => this.#inheritWorkspaceTitle(metadata),
                ...(this.#mcpToolProvider !== undefined
                    ? { mcpToolProvider: this.#mcpToolProvider }
                    : {}),
                onAppendEvent: (event) => this.#appendEvent(event),
                persistence: this,
                request: source.requestForSubagent(),
                projectId: sourceSnapshot.projectId,
                projectSecretIds: this.#projectSecrets(sourceSnapshot.projectId),
                secretRegistry: this.#secrets,
                restore: {
                    ...state,
                    ...(targetSessionId === undefined
                        ? {}
                        : {
                              agent: { ...state.agent, rootSessionId: targetSessionId },
                              id: targetSessionId,
                          }),
                    orderKey: this.#newLastSessionOrderKey(
                        sourceSnapshot.projectId,
                        sourceSnapshot.workspaceId,
                    ),
                },
                ...(sourceSnapshot.workspaceId === undefined
                    ? {}
                    : { workspaceId: sourceSnapshot.workspaceId }),
                ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
            });
            for (const message of state.messages) {
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
    ): InMemorySession {
        this.#assertAcceptingMutations();
        let session!: InMemorySession;
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
            const inheritedWorkspace =
                inherited?.workspaceId === undefined
                    ? undefined
                    : this.#projects.getWorkspace(inherited.projectId, inherited.workspaceId);
            if (inherited?.workspaceId !== undefined && inheritedWorkspace?.status !== "ready") {
                throw new Error("The parent session workspace is not ready.");
            }
            const ownership = (() => {
                if (inherited === undefined) {
                    return this.#projects.resolve(request.cwd, request.workspaceId);
                }
                const project = this.#projects.getProject(inherited.projectId);
                if (project === undefined) {
                    throw new Error("The parent session project was not found.");
                }
                return {
                    project,
                    ...(inheritedWorkspace === undefined ? {} : { workspace: inheritedWorkspace }),
                };
            })();
            session = new InMemorySession({
                agentManager: this.#agentManager,
                createEventId: createEventIdFactory(),
                ...(this.#createRuntime === undefined
                    ? {}
                    : { createRuntime: this.#createRuntime }),
                emitCreatedEvent: false,
                modelCatalog: this.#modelCatalog,
                onInitialTitle: (metadata) => this.#inheritWorkspaceTitle(metadata),
                ...(this.#mcpToolProvider !== undefined
                    ? { mcpToolProvider: this.#mcpToolProvider }
                    : {}),
                ...(metadata !== undefined ? { metadata } : {}),
                ...(contextMessages !== undefined
                    ? { initialContextMessages: contextMessages }
                    : {}),
                ...(id === undefined ? {} : { id }),
                onAppendEvent: (event) => this.#appendEvent(event),
                orderKey:
                    inherited === undefined
                        ? this.#newLastSessionOrderKey(
                              ownership.project.id,
                              ownership.workspace?.id,
                          )
                        : generateKeyBetween(null, null),
                persistence: this,
                projectId: ownership.project.id,
                projectSecretIds: this.#projectSecrets(ownership.project.id),
                request,
                ...(this.#taskDrain === undefined ? {} : { taskDrain: this.#taskDrain }),
                secretRegistry: this.#secrets,
                ...(ownership.workspace === undefined
                    ? {}
                    : { workspaceId: ownership.workspace.id }),
            });
            session.emitCreatedEvent();
        });
        this.#cacheSession(session);
        return session;
    }

    deleteQueuedRun(sessionId: string, runId: string): void {
        this.#database
            .prepare("DELETE FROM queued_runs WHERE session_id = ? AND run_id = ?")
            .run(sessionId, runId);
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

    findByAgentId(agentId: string): InMemorySession | undefined {
        const rows = this.#database
            .prepare("SELECT id FROM sessions WHERE agent_id = ? LIMIT 2")
            .all(agentId) as Record<string, unknown>[];
        if (rows.length !== 1) return undefined;
        return this.get(readString(rows[0] as Record<string, unknown>, "id"));
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
        this.#database
            .prepare(
                `
                INSERT INTO queued_runs (
                    session_id,
                    run_id,
                    debug,
                    debug_directory,
                    display_text,
                    kind,
                    text,
                    user_message_json,
                    integration_config_json,
                    created_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, run_id) DO UPDATE SET
                    debug = excluded.debug,
                    debug_directory = excluded.debug_directory,
                    display_text = excluded.display_text,
                    kind = excluded.kind,
                    text = excluded.text,
                    user_message_json = excluded.user_message_json,
                    integration_config_json = excluded.integration_config_json
                `,
            )
            .run(
                sessionId,
                run.runId,
                run.debug === true ? 1 : 0,
                run.debugDirectory ?? null,
                run.displayText,
                run.kind,
                run.text,
                JSON.stringify(run.userMessage),
                run.effort === undefined &&
                    run.externalTools === undefined &&
                    run.modelId === undefined &&
                    run.providerId === undefined &&
                    run.serviceTier === undefined &&
                    run.skills === undefined &&
                    run.systemPrompt === undefined
                    ? null
                    : JSON.stringify({
                          ...(run.externalTools === undefined
                              ? {}
                              : { externalTools: run.externalTools }),
                          ...(run.skills === undefined ? {} : { skills: run.skills }),
                          ...(run.effort === undefined ? {} : { effort: run.effort }),
                          ...(run.modelId === undefined ? {} : { modelId: run.modelId }),
                          ...(run.providerId === undefined ? {} : { providerId: run.providerId }),
                          ...(run.serviceTier === undefined
                              ? {}
                              : { serviceTier: run.serviceTier }),
                          ...(run.systemPrompt === undefined
                              ? {}
                              : { systemPrompt: run.systemPrompt }),
                      }),
                this.#now(),
            );
    }

    list(options: { limit?: number } = {}): readonly SessionSummary[] {
        return this.#listSessions(false, options);
    }

    listActive(options: { limit?: number } = {}): readonly SessionSummary[] {
        return this.#listSessions(true, options);
    }

    #listSessions(activeOnly: boolean, options: { limit?: number }): readonly SessionSummary[] {
        const rows = this.#database
            .prepare(
                `
                SELECT listed_sessions.*
                FROM (
                    SELECT
                        id,
                        project_id,
                        workspace_id,
                        order_key,
                        archive_on_idle,
                        archived,
                        track_unread,
                        unread_reason,
                        unread_since_ms,
                        cwd,
                        draft,
                        draft_updated_at_ms,
                        docker_json,
                        secret_ids_json,
                        provider_id,
                        model_id,
                        permission_mode,
                        effort,
                        service_tier,
                        status,
                        title,
                        title_status,
                        title_error,
                        recap,
                        session_token_count_json,
                        metadata_updated_at_ms,
                        metadata_run_id,
                        interruption_json,
                        created_at_ms,
                        updated_at_ms,
                        last_message_at_ms,
                        last_event_id
                    FROM sessions
                    WHERE parent_session_id IS NULL
                        ${activeOnly ? "AND archived = 0" : ""}
                ) AS listed_sessions
                JOIN projects ON projects.id = listed_sessions.project_id
                LEFT JOIN project_workspaces
                    ON project_workspaces.id = listed_sessions.workspace_id
                ORDER BY
                    projects.order_key ASC,
                    listed_sessions.workspace_id IS NOT NULL ASC,
                    project_workspaces.order_key ASC,
                    listed_sessions.order_key ASC,
                    listed_sessions.id ASC
                LIMIT ?
                `,
            )
            // Active catalogs are complete by design. Historical listings keep
            // their existing default bound unless a caller asks for another.
            .all(options.limit ?? (activeOnly ? -1 : 500));

        return rows.map((row) => {
            const effort = readOptionalString(row, "effort");
            const serviceTier = readOptionalString(row, "service_tier");
            const title = readOptionalString(row, "title");
            const titleError = readOptionalString(row, "title_error");
            const recap = readOptionalString(row, "recap");
            const sessionTokenCountJson = readOptionalString(row, "session_token_count_json");
            const metadataUpdatedAt = readOptionalNumber(row, "metadata_updated_at_ms");
            const metadataRunId = readOptionalString(row, "metadata_run_id");
            const lastMessageAt = readOptionalNumber(row, "last_message_at_ms");
            const lastEventId = readOptionalString(row, "last_event_id");
            const interruptionJson = readOptionalString(row, "interruption_json");
            const draft = readOptionalString(row, "draft");
            const draftUpdatedAt = readOptionalNumber(row, "draft_updated_at_ms");
            const dockerJson = readOptionalString(row, "docker_json");
            const unreadReason = readOptionalString(row, "unread_reason");
            const unreadSince = readOptionalNumber(row, "unread_since_ms");
            const workspaceId = readOptionalString(row, "workspace_id");
            return {
                id: readString(row, "id"),
                archived: readNumber(row, "archived") !== 0,
                projectId: readString(row, "project_id"),
                orderKey: readString(row, "order_key"),
                ...(workspaceId === undefined ? {} : { workspaceId }),
                archiveOnIdle: readNumber(row, "archive_on_idle") !== 0,
                trackUnread: readNumber(row, "track_unread") !== 0,
                ...(unreadReason !== undefined && unreadSince !== undefined
                    ? {
                          unread: {
                              reason: unreadReason as SessionUnreadReason,
                              since: unreadSince,
                          },
                      }
                    : {}),
                cwd: readString(row, "cwd"),
                ...(draft === undefined ? {} : { draft }),
                ...(draftUpdatedAt === undefined ? {} : { draftUpdatedAt }),
                providerId: readString(row, "provider_id"),
                modelId: readString(row, "model_id"),
                permissionMode: parsePermissionMode(readString(row, "permission_mode")),
                environment: summarizeDockerExecution(
                    dockerJson === undefined
                        ? undefined
                        : (JSON.parse(dockerJson) as DockerExecutionConfig),
                ),
                ...(effort !== undefined ? { effort } : {}),
                ...(serviceTier === "fast" ? { serviceTier } : {}),
                status: readString(row, "status") as SessionSummary["status"],
                titleStatus: readString(row, "title_status") as SessionTitleStatus,
                createdAt: readNumber(row, "created_at_ms"),
                updatedAt: readNumber(row, "updated_at_ms"),
                ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
                ...(lastEventId !== undefined ? { lastEventId } : {}),
                ...(title !== undefined ? { title } : {}),
                ...(titleError !== undefined ? { titleError } : {}),
                ...(recap !== undefined ? { recap } : {}),
                ...(sessionTokenCountJson !== undefined
                    ? {
                          sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount,
                      }
                    : {}),
                ...(metadataUpdatedAt !== undefined ? { metadataUpdatedAt } : {}),
                ...(metadataRunId !== undefined ? { metadataRunId } : {}),
                ...(interruptionJson !== undefined
                    ? { interruption: JSON.parse(interruptionJson) as SessionInterruption }
                    : {}),
            };
        });
    }

    loadedSessions(): readonly InMemorySession[] {
        return this.#cachedSessions();
    }

    listExternalToolCalls(
        options: { limit?: number; status?: ExternalToolCall["status"] } = {},
    ): readonly ExternalToolCall[] {
        const rows =
            options.status === undefined
                ? this.#database
                      .prepare(
                          "SELECT * FROM external_tool_calls ORDER BY created_at_ms ASC, tool_call_index ASC LIMIT ?",
                      )
                      .all(options.limit ?? 100)
                : this.#database
                      .prepare(
                          "SELECT * FROM external_tool_calls WHERE status = ? ORDER BY created_at_ms ASC, tool_call_index ASC LIMIT ?",
                      )
                      .all(options.status, options.limit ?? 100);
        return rows.map(readExternalToolCallRow);
    }

    listSubagents(parentSessionId: string): readonly SubagentSummary[] {
        return this.#database
            .prepare(
                `
                WITH RECURSIVE descendants(id) AS (
                    SELECT id
                    FROM sessions
                    WHERE parent_session_id = ?
                    UNION ALL
                    SELECT sessions.id
                    FROM sessions
                    JOIN descendants ON sessions.parent_session_id = descendants.id
                )
                SELECT
                    id,
                    agent_id,
                    model_id,
                    status,
                    active_since_ms,
                    elapsed_ms,
                    total_tokens,
                    session_token_count_json,
                    usage_json,
                    parent_session_id,
                    parent_tool_call_id,
                    task_name,
                    depth,
                    description,
                    created_at_ms,
                    updated_at_ms
                FROM sessions
                WHERE id IN descendants
                ORDER BY created_at_ms ASC
                `,
            )
            .all(parentSessionId)
            .map((row) => {
                const parentToolCallId = readOptionalString(row, "parent_tool_call_id");
                const taskName = readOptionalString(row, "task_name");
                const activeSince = readOptionalNumber(row, "active_since_ms");
                const sessionTokenCountJson = readOptionalString(row, "session_token_count_json");
                const usageJson = readOptionalString(row, "usage_json");
                const persistedUsage = parsePersistedUsage(usageJson);
                return {
                    ...(activeSince === undefined ? {} : { activeSince }),
                    agentId: readString(row, "agent_id"),
                    createdAt: readNumber(row, "created_at_ms"),
                    depth: readNumber(row, "depth"),
                    description: readOptionalString(row, "description") ?? "Delegated task",
                    elapsedMs: readNumber(row, "elapsed_ms"),
                    id: readString(row, "id"),
                    modelId: readString(row, "model_id"),
                    parentSessionId: readString(row, "parent_session_id"),
                    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
                    status: readString(row, "status") as SubagentSummary["status"],
                    ...(taskName !== undefined ? { taskName } : {}),
                    totalTokens: readNumber(row, "total_tokens"),
                    ...(sessionTokenCountJson === undefined
                        ? {}
                        : {
                              sessionTokenCount: JSON.parse(
                                  sessionTokenCountJson,
                              ) as SessionTokenCount,
                          }),
                    updatedAt: readNumber(row, "updated_at_ms"),
                    ...(persistedUsage === undefined ? {} : { usage: persistedUsage.committed }),
                };
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
            if (identity.projectId !== target.projectId) continue;
            if (identity.workspaceId !== target.workspaceId) continue;
            session.recordGitState(git);
        }
    }

    listProjects(): readonly Project[] {
        return this.#projects.listProjects();
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
                orderKeyAfter(
                    this.#sessionOrderItems(snapshot.projectId, snapshot.workspaceId),
                    sessionId,
                    request.afterId,
                ),
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
    ): Promise<ProjectWorkspace | undefined> {
        return this.#projects.createWorkspace(projectId, request);
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
        let workspaces: {
            cleanup: Promise<void>[];
            workspaceId: string;
        }[] = [];
        this.#transaction(() => {
            project = this.#projects.archiveProject(projectId, expectedVersion);
            if (project === undefined) return;
            const rootSessionIds = this.#database
                .prepare(
                    `
                    SELECT id FROM sessions
                    WHERE project_id = ? AND workspace_id IS NULL AND parent_session_id IS NULL
                    `,
                )
                .all(projectId)
                .map((row) => readString(row, "id"));
            for (const sessionId of rootSessionIds) this.get(sessionId)?.setArchived(true);
            workspaces = this.#projects.listWorkspaces(projectId).flatMap((workspace) => {
                if (workspace.status === "archived" || workspace.status === "archiving") {
                    return [];
                }
                const archiving = this.#projects.beginWorkspaceArchive(projectId, workspace.id);
                if (archiving === undefined || archiving.status === "archived") return [];
                return [
                    {
                        cleanup: this.#database
                            .prepare("SELECT id FROM sessions WHERE workspace_id = ?")
                            .all(workspace.id)
                            .map((row) =>
                                this.get(readString(row, "id"))?.archiveForWorkspace(workspace.id),
                            )
                            .filter((task): task is Promise<void> => task !== undefined),
                        workspaceId: workspace.id,
                    },
                ];
            });
        });
        if (project === undefined) return undefined;
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
        const archive = () => this.#archiveWorkspace(projectId, workspaceId, expectedVersion);
        return this.#taskDrain?.run(archive) ?? archive();
    }

    async #archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        let workspace: ProjectWorkspace | undefined;
        let cleanup: Promise<void>[] = [];
        this.#transaction(() => {
            workspace = this.#projects.beginWorkspaceArchive(
                projectId,
                workspaceId,
                expectedVersion,
            );
            if (workspace === undefined || workspace.status === "archived") return;
            cleanup = this.#database
                .prepare("SELECT id FROM sessions WHERE workspace_id = ?")
                .all(workspaceId)
                .map((row) => this.get(readString(row, "id"))?.archiveForWorkspace(workspaceId))
                .filter((task): task is Promise<void> => task !== undefined);
        });
        if (workspace === undefined || workspace.status === "archived") return workspace;
        await this.remoteTerminals.closeWorkspace(projectId, workspaceId);
        return this.#completeWorkspaceArchive(projectId, workspaceId, cleanup);
    }

    async #completeWorkspaceArchive(
        projectId: string,
        workspaceId: string,
        cleanup: readonly Promise<void>[],
    ): Promise<ProjectWorkspace | undefined> {
        const results = await Promise.allSettled(cleanup);
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure !== undefined) {
            return this.#projects.failWorkspaceArchive(
                projectId,
                workspaceId,
                errorToMessage(failure.reason),
            );
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
        this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    INSERT INTO secret_registrations (id, description, environment_json)
                    VALUES (?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        description = excluded.description,
                        environment_json = excluded.environment_json
                    `,
                )
                .run(request.id, request.description.trim(), JSON.stringify(request.environment));
            const rememberEnvironmentVariable = this.#database.prepare(
                `
                INSERT INTO secret_environment_variables (secret_id, normalized_name, name)
                VALUES (?, ?, ?)
                ON CONFLICT(secret_id, normalized_name) DO UPDATE SET name = excluded.name
                `,
            );
            for (const name of Object.keys(request.environment)) {
                rememberEnvironmentVariable.run(request.id, name.toUpperCase(), name);
            }
        });
        this.#secrets.register(request);
        return candidate.reference(request.id);
    }

    unregisterSecret(secretId: string): boolean {
        if (!this.#secrets.references().some((secret) => secret.id === secretId)) return false;
        const rows = this.#database.prepare("SELECT id, secret_ids_json FROM sessions").all();
        const update = this.#database.prepare(
            "UPDATE sessions SET secret_ids_json = ? WHERE id = ?",
        );
        this.#transaction(() => {
            this.#database.prepare("DELETE FROM secret_registrations WHERE id = ?").run(secretId);
            for (const row of rows) {
                const ids = JSON.parse(readString(row, "secret_ids_json")) as string[];
                update.run(
                    JSON.stringify(ids.filter((id) => id !== secretId)),
                    readString(row, "id"),
                );
            }
            this.#database
                .prepare("DELETE FROM project_secret_attachments WHERE secret_id = ?")
                .run(secretId);
        });
        this.#secrets.unregister(secretId);
        for (const session of this.#cachedSessions()) {
            session.detachSecret(secretId, { scope: "project" });
            session.detachSecret(secretId, { scope: "session" });
        }
        return true;
    }

    #listSubagentSessionsByRoot(rootSessionId: string): readonly InMemorySession[] {
        return this.#database
            .prepare(
                `
                SELECT id
                FROM sessions
                WHERE root_session_id = ? AND session_kind = 'subagent'
                ORDER BY created_at_ms ASC
                `,
            )
            .all(rootSessionId)
            .map((row) => this.get(readString(row, "id")))
            .filter((session): session is InMemorySession => session !== undefined);
    }

    repairInterruptedSessions(reason: SessionInterruption["reason"]): void {
        const rows = this.#database
            .prepare(
                `
                SELECT DISTINCT sessions.id, sessions.active_run_id
                FROM sessions
                LEFT JOIN queued_runs ON queued_runs.session_id = sessions.id
                WHERE sessions.status IN ('queued', 'running')
                    OR sessions.active_run_id IS NOT NULL
                    OR queued_runs.run_id IS NOT NULL
                `,
            )
            .all();

        for (const row of rows) {
            const sessionId = readString(row, "id");
            const activeRunId = readOptionalString(row, "active_run_id");
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
                parent?.recordSubagentStoppedAfterRestart(session.subagentSummary());
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
        const row = this.#database
            .prepare(
                `
                SELECT type, data_json
                FROM session_events
                WHERE session_id = ?
                    AND type IN ('run_finished', 'run_error')
                    AND json_extract(data_json, '$.runId') = ?
                ORDER BY seq DESC
                LIMIT 1
                `,
            )
            .get(sessionId, runId);
        if (row === undefined) return false;

        const type = readString(row, "type");
        const data = JSON.parse(readString(row, "data_json")) as { stopReason?: string };
        const status =
            type === "run_error"
                ? "error"
                : data.stopReason === "aborted"
                  ? "aborted"
                  : "completed";
        this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE sessions
                    SET
                        status = ?,
                        active_run_id = NULL,
                        active_since_ms = NULL,
                        interrupted = 0,
                        interruption_json = NULL,
                        last_event_id = (
                            SELECT event_id
                            FROM session_events
                            WHERE session_id = ?
                            ORDER BY seq DESC
                            LIMIT 1
                        ),
                        updated_at_ms = ?
                    WHERE id = ?
                    `,
                )
                .run(status, sessionId, this.#now(), sessionId);
            this.#database
                .prepare("DELETE FROM queued_runs WHERE session_id = ? AND run_id = ?")
                .run(sessionId, runId);
        });
        return true;
    }

    async prepareForShutdown(reason: SessionInterruption["reason"]): Promise<void> {
        this.#taskDrain?.beginClose();
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
        const projectId = state.projectId ?? this.#projects.resolve(state.cwd).project.id;
        this.#database
            .prepare(
                `
                INSERT INTO sessions (
                    id,
                    agent_id,
                    project_id,
                    workspace_id,
                    order_key,
                    session_kind,
                    parent_session_id,
                    root_session_id,
                    depth,
                    parent_tool_call_id,
                    task_name,
                    description,
                    archive_on_idle,
                    archived,
                    track_unread,
                    unread_reason,
                    unread_since_ms,
                    cwd,
                    draft,
                    draft_updated_at_ms,
                    docker_json,
                    secret_ids_json,
                    provider_id,
                    model_id,
                    effort,
                    service_tier,
                    instructions,
                    append_system_prompt,
                    system_prompt,
                    external_tools_json,
                    durable_skills_json,
                    status,
                    active_run_id,
                    active_since_ms,
                    elapsed_ms,
                    total_tokens,
                    session_token_count_json,
                    usage_json,
                    permission_mode,
                    context_messages_json,
                    models_json,
                    tools_json,
                    tasks_json,
                    workflows_json,
                    workflows_enabled,
                    goal_json,
                    next_task_id,
                    title,
                    title_status,
                    title_error,
                    recap,
                    metadata_updated_at_ms,
                    metadata_run_id,
                    interrupted,
                    interruption_json,
                    last_message_at_ms,
                    created_at_ms,
                    updated_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    agent_id = excluded.agent_id,
                    project_id = excluded.project_id,
                    workspace_id = excluded.workspace_id,
                    order_key = excluded.order_key,
                    session_kind = excluded.session_kind,
                    parent_session_id = excluded.parent_session_id,
                    root_session_id = excluded.root_session_id,
                    depth = excluded.depth,
                    parent_tool_call_id = excluded.parent_tool_call_id,
                    task_name = excluded.task_name,
                    description = excluded.description,
                    archive_on_idle = excluded.archive_on_idle,
                    archived = excluded.archived,
                    track_unread = excluded.track_unread,
                    unread_reason = excluded.unread_reason,
                    unread_since_ms = excluded.unread_since_ms,
                    cwd = excluded.cwd,
                    draft = excluded.draft,
                    draft_updated_at_ms = excluded.draft_updated_at_ms,
                    docker_json = excluded.docker_json,
                    secret_ids_json = excluded.secret_ids_json,
                    provider_id = excluded.provider_id,
                    model_id = excluded.model_id,
                    effort = excluded.effort,
                    service_tier = excluded.service_tier,
                    instructions = excluded.instructions,
                    append_system_prompt = excluded.append_system_prompt,
                    system_prompt = excluded.system_prompt,
                    external_tools_json = excluded.external_tools_json,
                    durable_skills_json = excluded.durable_skills_json,
                    status = excluded.status,
                    active_run_id = excluded.active_run_id,
                    active_since_ms = excluded.active_since_ms,
                    elapsed_ms = excluded.elapsed_ms,
                    total_tokens = excluded.total_tokens,
                    session_token_count_json = excluded.session_token_count_json,
                    usage_json = excluded.usage_json,
                    permission_mode = excluded.permission_mode,
                    context_messages_json = excluded.context_messages_json,
                    models_json = excluded.models_json,
                    tools_json = excluded.tools_json,
                    tasks_json = excluded.tasks_json,
                    workflows_json = excluded.workflows_json,
                    workflows_enabled = excluded.workflows_enabled,
                    goal_json = excluded.goal_json,
                    next_task_id = excluded.next_task_id,
                    title = excluded.title,
                    title_status = excluded.title_status,
                    title_error = excluded.title_error,
                    recap = excluded.recap,
                    metadata_updated_at_ms = excluded.metadata_updated_at_ms,
                    metadata_run_id = excluded.metadata_run_id,
                    interrupted = excluded.interrupted,
                    interruption_json = excluded.interruption_json,
                    last_message_at_ms = excluded.last_message_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                `,
            )
            .run(
                state.id,
                state.agentId,
                projectId,
                state.workspaceId ?? null,
                state.orderKey,
                state.agent.type,
                state.agent.parentSessionId ?? null,
                state.agent.rootSessionId,
                state.agent.depth,
                state.agent.parentToolCallId ?? null,
                state.agent.taskName ?? null,
                state.agent.description ?? null,
                state.archiveOnIdle === true ? 1 : 0,
                state.archived === true ? 1 : 0,
                state.trackUnread === true ? 1 : 0,
                state.unread?.reason ?? null,
                state.unread?.since ?? null,
                state.cwd,
                state.draft ?? null,
                state.draftUpdatedAt ?? null,
                state.docker === undefined ? null : JSON.stringify(state.docker),
                JSON.stringify(state.secretIds ?? []),
                state.providerId,
                state.modelId,
                state.effort ?? null,
                state.serviceTier ?? null,
                state.instructions ?? null,
                state.appendSystemPrompt ?? null,
                state.systemPrompt ?? null,
                JSON.stringify(state.externalTools ?? []),
                JSON.stringify(state.skills ?? []),
                state.status,
                state.activeRunId ?? null,
                state.activeSince ?? null,
                state.elapsedMs ?? 0,
                state.totalTokens ?? 0,
                state.sessionTokenCount === undefined
                    ? null
                    : JSON.stringify(state.sessionTokenCount),
                state.usage === undefined
                    ? null
                    : JSON.stringify({
                          committed: state.usage,
                          ...(state.usageSummary === undefined
                              ? {}
                              : { summary: state.usageSummary }),
                          ...(state.usageSummaryEventId === undefined
                              ? {}
                              : { throughEventId: state.usageSummaryEventId }),
                          permissionReviews: state.permissionReviews ?? [],
                      } satisfies PersistedUsageEnvelope),
                state.permissionMode,
                state.contextMessages === undefined ? null : JSON.stringify(state.contextMessages),
                JSON.stringify(state.models),
                JSON.stringify(state.tools),
                JSON.stringify(state.tasks),
                JSON.stringify(state.workflows ?? []),
                state.workflowsEnabled === false ? 0 : 1,
                state.goal === undefined ? null : JSON.stringify(state.goal),
                state.nextTaskId,
                state.title ?? null,
                state.titleStatus,
                state.titleError ?? null,
                state.recap ?? null,
                state.metadataUpdatedAt ?? null,
                state.metadataRunId ?? null,
                state.interruption === undefined ? 0 : 1,
                state.interruption === undefined ? null : JSON.stringify(state.interruption),
                state.lastMessageAt ?? null,
                this.#now(),
                this.#now(),
            );
    }

    #assertAcceptingMutations(): void {
        if (this.#taskDrain?.closing === true) {
            throw new Error("The local daemon is shutting down.");
        }
    }

    upsertMessage(sessionId: string, message: PersistedSessionMessage): void {
        this.#transaction(() => {
            this.#database
                .prepare(
                    `
                INSERT INTO session_messages (
                    session_id,
                    position,
                    message_id,
                    role,
                    is_partial,
                    run_id,
                    message_json,
                    updated_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, position) DO UPDATE SET
                    message_id = excluded.message_id,
                    role = excluded.role,
                    is_partial = excluded.is_partial,
                    run_id = excluded.run_id,
                    message_json = excluded.message_json,
                    updated_at_ms = excluded.updated_at_ms
                `,
                )
                .run(
                    sessionId,
                    message.position,
                    message.message.id,
                    message.message.role,
                    message.isPartial ? 1 : 0,
                    message.runId ?? null,
                    JSON.stringify(message.message),
                    this.#now(),
                );
            if (!message.isPartial && message.runId !== undefined) {
                this.#database
                    .prepare(
                        `
                    INSERT INTO session_turns (session_id, run_id, first_position)
                    VALUES (?, ?, ?)
                    ON CONFLICT(session_id, run_id) DO UPDATE SET
                        first_position = MIN(first_position, excluded.first_position)
                    `,
                    )
                    .run(sessionId, message.runId, message.position);
            }
        });
    }

    loadTranscriptPage(
        sessionId: string,
        turnLimit: number,
        before?: string,
    ): SessionTranscriptWindow | undefined {
        const messages = this.#loadTranscriptMessagesPage(sessionId, turnLimit, before);
        if (messages === undefined) return undefined;
        const firstPosition = messages[0]?.position;
        const hasEarlier =
            firstPosition !== undefined &&
            this.#database
                .prepare(
                    `
                    SELECT 1
                    FROM session_messages
                    WHERE session_id = ? AND position < ? AND is_partial = 0
                      AND COALESCE(json_extract(message_json, '$.internal'), 0) != 1
                    LIMIT 1
                    `,
                )
                .get(sessionId, firstPosition) !== undefined;
        return this.#transcriptWindowForMessages(sessionId, messages, turnLimit, !hasEarlier);
    }

    loadTranscriptSince(
        sessionId: string,
        turnLimit: number,
        after: EventId,
    ): SessionTranscriptWindow | undefined {
        const messages = this.#loadTranscriptMessagesSince(sessionId, turnLimit, after);
        if (messages === undefined) return undefined;
        const lastPosition = messages.at(-1)?.position;
        const hasLater =
            lastPosition !== undefined &&
            this.#database
                .prepare(
                    `
                    SELECT 1
                    FROM session_messages
                    WHERE session_id = ? AND position > ? AND is_partial = 0
                      AND COALESCE(json_extract(message_json, '$.internal'), 0) != 1
                    LIMIT 1
                    `,
                )
                .get(sessionId, lastPosition) !== undefined;
        return this.#transcriptWindowForMessages(sessionId, messages, turnLimit, !hasLater);
    }

    upsertExternalToolCall(call: ExternalToolCall): void {
        this.#database
            .prepare(
                `
                INSERT INTO external_tool_calls (
                    id,
                    session_id,
                    run_id,
                    batch_id,
                    tool_call_id,
                    provider_tool_call_id,
                    tool_call_index,
                    definition_json,
                    skill_json,
                    arguments_json,
                    status,
                    resolution_json,
                    consumed,
                    created_at_ms,
                    resolved_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    resolution_json = excluded.resolution_json,
                    consumed = excluded.consumed,
                    resolved_at_ms = excluded.resolved_at_ms
                `,
            )
            .run(
                call.id,
                call.sessionId,
                call.runId,
                call.batchId,
                call.toolCallId,
                call.providerToolCallId ?? null,
                call.toolCallIndex,
                JSON.stringify(call.definition),
                call.skill === undefined ? null : JSON.stringify(call.skill),
                JSON.stringify(call.arguments),
                call.status,
                call.resolution === undefined ? null : JSON.stringify(call.resolution),
                call.consumed ? 1 : 0,
                call.createdAt,
                call.resolvedAt ?? null,
            );
    }

    handoffDurablePermissionToExternalTool(
        externalCall: ExternalToolCall,
        permissionCall: DurableUserInputCall,
    ): void {
        this.#transaction(() => {
            this.upsertExternalToolCall(externalCall);
            this.upsertDurableUserInput(permissionCall);
        });
    }

    upsertDurableUserInput(call: DurableUserInputCall): void {
        this.#database
            .prepare(
                `
                INSERT INTO durable_user_inputs (
                    session_id,
                    request_id,
                    run_id,
                    batch_id,
                    tool_call_id,
                    provider_tool_call_id,
                    tool_call_index,
                    tool_name,
                    tool_arguments_json,
                    kind,
                    permission_json,
                    request_json,
                    response_json,
                    result_json,
                    status,
                    consumed,
                    created_at_ms,
                    resolved_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, request_id) DO UPDATE SET
                    response_json = excluded.response_json,
                    result_json = excluded.result_json,
                    status = excluded.status,
                    consumed = excluded.consumed,
                    resolved_at_ms = excluded.resolved_at_ms
                `,
            )
            .run(
                call.sessionId,
                call.request.requestId,
                call.runId,
                call.batchId,
                call.toolCallId,
                call.providerToolCallId ?? null,
                call.toolCallIndex,
                call.toolName,
                JSON.stringify(call.toolArguments),
                call.kind,
                call.permission === undefined ? null : JSON.stringify(call.permission),
                JSON.stringify(call.request),
                call.response === undefined ? null : JSON.stringify(call.response),
                call.result === undefined ? null : JSON.stringify(call.result),
                call.status,
                call.consumed ? 1 : 0,
                call.createdAt,
                call.resolvedAt ?? null,
            );
    }

    pruneExternalToolCalls(sessionId: string, retain: number): void {
        this.#database
            .prepare(
                `
                DELETE FROM external_tool_calls
                WHERE session_id = ?
                    AND (status = 'cancelled' OR consumed = 1)
                    AND id NOT IN (
                        SELECT id
                        FROM external_tool_calls
                        WHERE session_id = ?
                            AND (status = 'cancelled' OR consumed = 1)
                        ORDER BY COALESCE(resolved_at_ms, created_at_ms) DESC,
                            tool_call_index DESC
                        LIMIT ?
                    )
                `,
            )
            .run(sessionId, sessionId, retain);
    }

    pruneDurableUserInputs(sessionId: string, retain: number): void {
        this.#database
            .prepare(
                `
                DELETE FROM durable_user_inputs
                WHERE session_id = ?
                    AND (status = 'cancelled' OR consumed = 1)
                    AND request_id NOT IN (
                        SELECT request_id
                        FROM durable_user_inputs
                        WHERE session_id = ?
                            AND (status = 'cancelled' OR consumed = 1)
                        ORDER BY COALESCE(resolved_at_ms, created_at_ms) DESC,
                            tool_call_index DESC
                        LIMIT ?
                    )
                `,
            )
            .run(sessionId, sessionId, retain);
    }

    #appendEvent(event: SessionEvent): void {
        if (isLiveOnlySessionEvent(event)) {
            this.#database
                .prepare(
                    `
                    UPDATE sessions
                    SET last_event_id = ?, updated_at_ms = ?
                    WHERE id = ?
                    `,
                )
                .run(event.id, this.#now(), event.sessionId);
            this.#publishLiveStream(event);
            this.#publishGlobalEvent(event);
            this.#notifySessionEvent(event);
            return;
        }
        const eventFacts = sessionEventFacts(event);
        let globalEntry: ReturnType<GlobalEventQueue["append"]>;
        this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    INSERT INTO session_events (
                        session_id,
                        event_id,
                        type,
                        created_at_ms,
                        data_json,
                        run_id,
                        message_id,
                        tool_call_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                )
                .run(
                    event.sessionId,
                    event.id,
                    event.type,
                    event.createdAt,
                    JSON.stringify(event.data),
                    eventFacts.runId ?? null,
                    eventFacts.messageId ?? null,
                    eventFacts.toolCallId ?? null,
                );
            if (this.#globalEventQueue.durable) {
                globalEntry = this.#globalEventQueue.append(event);
            }
            this.#database
                .prepare(
                    `
                    UPDATE sessions
                    SET last_event_id = ?, updated_at_ms = ?
                    WHERE id = ?
                    `,
                )
                .run(event.id, this.#now(), event.sessionId);
        });
        // The live stream carries this event whether or not the durable log
        // keeps it, but never before the row it describes is committed.
        this.#publishLiveStream(event);
        if (this.#globalEventQueue.durable && globalEntry !== undefined) {
            const queue = this.#globalEventQueue;
            this.#afterTransactionCommit(() => queue.publish(globalEntry!));
        } else if (!this.#globalEventQueue.durable && shouldPublishGlobalEvent(event)) {
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
        const entry = queue.append(event);
        if (entry !== undefined) {
            this.#afterTransactionCommit(() => queue.publish(entry));
        }
    }

    #notifySessionAccess(session: InMemorySession): void {
        try {
            this.#onSessionAccess?.(session);
        } catch {
            // External synchronization must never interrupt local session access.
        }
    }

    #notifySessionEvent(event: SessionEvent): void {
        try {
            this.#onSessionEvent?.(event, this.#sessions.get(event.sessionId)?.deref());
        } catch {
            // The event is already durable; optional observers cannot roll it back.
        }
    }

    #loadSecretRegistrations(): void {
        const rows = this.#database
            .prepare("SELECT id, description, environment_json FROM secret_registrations")
            .all();
        for (const row of rows) {
            this.#secrets.register({
                description: readString(row, "description"),
                environment: JSON.parse(readString(row, "environment_json")) as Readonly<
                    Record<string, string>
                >,
                id: readString(row, "id"),
            });
        }
        const rememberEnvironmentVariable = this.#database.prepare(
            `
            INSERT OR IGNORE INTO secret_environment_variables (secret_id, normalized_name, name)
            VALUES (?, ?, ?)
            `,
        );
        for (const secret of this.#secrets.references()) {
            for (const name of secret.environmentVariables) {
                rememberEnvironmentVariable.run(secret.id, name.toUpperCase(), name);
            }
        }
        const environmentRows = this.#database
            .prepare("SELECT secret_id, name FROM secret_environment_variables")
            .all();
        for (const row of environmentRows) {
            this.#secrets.rememberEnvironmentVariables(readString(row, "secret_id"), [
                readString(row, "name"),
            ]);
        }
    }

    #loadEvents(sessionId: string, bounded = true): SessionEvent[] {
        const rows = this.#database
            .prepare(
                bounded
                    ? `
                SELECT event_id, type, created_at_ms, data_json
                FROM (
                    SELECT seq, event_id, type, created_at_ms, data_json
                    FROM session_events
                    WHERE session_id = ?
                    ORDER BY seq DESC
                    LIMIT ?
                )
                ORDER BY seq ASC
                `
                    : `
                SELECT event_id, type, created_at_ms, data_json
                FROM session_events
                WHERE session_id = ?
                ORDER BY seq ASC
                `,
            )
            .iterate(...(bounded ? [sessionId, RESTORED_SESSION_EVENT_LIMIT] : [sessionId]));
        const events: SessionEvent[] = [];
        for (const row of rows) {
            const event = {
                createdAt: readNumber(row, "created_at_ms"),
                data: JSON.parse(readString(row, "data_json")) as SessionEvent["data"],
                id: readString(row, "event_id"),
                sessionId,
                type: readString(row, "type") as SessionEvent["type"],
            } as SessionEvent;
            events.push(event);
        }
        return events;
    }

    #loadMessages(sessionId: string, bounded = true): PersistedSessionMessage[] {
        return this.#database
            .prepare(
                bounded
                    ? `
                SELECT position, is_partial, run_id, message_json
                FROM (
                    SELECT position, is_partial, run_id, message_json
                    FROM session_messages
                    WHERE session_id = ?
                    ORDER BY position DESC
                    LIMIT ?
                )
                ORDER BY position ASC
                `
                    : `
                SELECT position, is_partial, run_id, message_json
                FROM session_messages
                WHERE session_id = ?
                ORDER BY position ASC
                `,
            )
            .all(...(bounded ? [sessionId, RESTORED_SESSION_MESSAGE_LIMIT] : [sessionId]))
            .map((row) => {
                const runId = readOptionalString(row, "run_id");
                const message: PersistedSessionMessage = {
                    isPartial: readNumber(row, "is_partial") !== 0,
                    message: JSON.parse(readString(row, "message_json")) as Message,
                    position: readNumber(row, "position"),
                };
                if (runId !== undefined) {
                    message.runId = runId;
                }
                return message;
            });
    }

    #loadQueuedRuns(sessionId: string): PersistedQueuedRun[] {
        return this.#database
            .prepare(
                `
                SELECT run_id, debug, debug_directory, display_text, kind, text, user_message_json,
                    integration_config_json
                FROM queued_runs
                WHERE session_id = ?
                ORDER BY created_at_ms ASC
                `,
            )
            .all(sessionId)
            .map((row) => {
                const debugDirectory = readOptionalString(row, "debug_directory");
                const integrationConfigJson = readOptionalString(row, "integration_config_json");
                const integrationConfig =
                    integrationConfigJson === undefined
                        ? {}
                        : (JSON.parse(integrationConfigJson) as {
                              effort?: string;
                              externalTools?: readonly ExternalToolDefinition[];
                              modelId?: string;
                              providerId?: string;
                              serviceTier?: ServiceTier | null;
                              skills?: readonly DurableSkillDefinition[];
                              systemPrompt?: string | null;
                          });
                return {
                    ...(readNumber(row, "debug") === 0 ? {} : { debug: true }),
                    ...(debugDirectory === undefined ? {} : { debugDirectory }),
                    displayText: readString(row, "display_text"),
                    kind: readString(row, "kind") as PersistedQueuedRun["kind"],
                    runId: readString(row, "run_id"),
                    text: readString(row, "text"),
                    userMessage: JSON.parse(readString(row, "user_message_json")),
                    ...integrationConfig,
                };
            }) as PersistedQueuedRun[];
    }

    #loadExternalToolCalls(sessionId: string): ExternalToolCall[] {
        return this.#database
            .prepare(
                `
                SELECT *
                FROM external_tool_calls
                WHERE session_id = ?
                ORDER BY created_at_ms ASC, tool_call_index ASC
                `,
            )
            .all(sessionId)
            .map(readExternalToolCallRow);
    }

    #loadDurableUserInputs(sessionId: string): DurableUserInputCall[] {
        return this.#database
            .prepare(
                `
                SELECT *
                FROM durable_user_inputs
                WHERE session_id = ?
                ORDER BY created_at_ms ASC, tool_call_index ASC
                `,
            )
            .all(sessionId)
            .map((row) => {
                const permissionJson = readOptionalString(row, "permission_json");
                const providerToolCallId = readOptionalString(row, "provider_tool_call_id");
                const responseJson = readOptionalString(row, "response_json");
                const resultJson = readOptionalString(row, "result_json");
                const resolvedAt = readOptionalNumber(row, "resolved_at_ms");
                return {
                    batchId: readString(row, "batch_id"),
                    consumed: readNumber(row, "consumed") !== 0,
                    createdAt: readNumber(row, "created_at_ms"),
                    kind: readString(row, "kind") as DurableUserInputCall["kind"],
                    ...(permissionJson === undefined
                        ? {}
                        : { permission: JSON.parse(permissionJson) }),
                    ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
                    request: JSON.parse(readString(row, "request_json")),
                    ...(responseJson === undefined ? {} : { response: JSON.parse(responseJson) }),
                    ...(resolvedAt === undefined ? {} : { resolvedAt }),
                    ...(resultJson === undefined ? {} : { result: JSON.parse(resultJson) }),
                    runId: readString(row, "run_id"),
                    sessionId: readString(row, "session_id"),
                    status: readString(row, "status") as DurableUserInputCall["status"],
                    toolArguments: JSON.parse(readString(row, "tool_arguments_json")),
                    toolCallId: readString(row, "tool_call_id"),
                    toolCallIndex: readNumber(row, "tool_call_index"),
                    toolName: readString(row, "tool_name"),
                };
            });
    }

    #inheritWorkspaceTitle(
        metadata: Parameters<NonNullable<InMemorySessionOptions["onInitialTitle"]>>[0],
    ): void {
        const first = this.#database
            .prepare(
                `
                SELECT id
                FROM sessions
                WHERE project_id = ? AND workspace_id = ? AND parent_session_id IS NULL
                ORDER BY created_at_ms ASC, id ASC
                LIMIT 1
                `,
            )
            .get(metadata.projectId, metadata.workspaceId);
        if (first === undefined || readString(first, "id") !== metadata.sessionId) return;
        this.#projects.inheritWorkspaceTitle(
            metadata.projectId,
            metadata.workspaceId,
            metadata.title,
        );
    }

    #loadSession(sessionId: string): InMemorySession | undefined {
        const row = this.#database
            .prepare(
                `
                SELECT *
                FROM sessions
                WHERE id = ?
                `,
            )
            .get(sessionId);
        if (row === undefined) {
            return undefined;
        }

        const effort = readOptionalString(row, "effort");
        const archiveOnIdle = readNumber(row, "archive_on_idle") !== 0;
        const archived = readNumber(row, "archived") !== 0;
        const trackUnread = readNumber(row, "track_unread") !== 0;
        const unreadReason = readOptionalString(row, "unread_reason");
        const unreadSince = readOptionalNumber(row, "unread_since_ms");
        const serviceTier = readOptionalString(row, "service_tier");
        const draft = readOptionalString(row, "draft");
        const draftUpdatedAt = readOptionalNumber(row, "draft_updated_at_ms");
        const dockerJson = readOptionalString(row, "docker_json");
        const secretIdsJson = readOptionalString(row, "secret_ids_json");
        const instructions = readOptionalString(row, "instructions");
        const appendSystemPrompt = readOptionalString(row, "append_system_prompt");
        const systemPrompt = readOptionalString(row, "system_prompt");
        const interruptionJson = readOptionalString(row, "interruption_json");
        const sessionTokenCountJson = readOptionalString(row, "session_token_count_json");
        const usageJson = readOptionalString(row, "usage_json");
        const persistedUsage = parsePersistedUsage(usageJson);
        const transcriptMessages = this.#loadTranscriptMessagesPage(sessionId, 80) ?? [];
        const messages = [...transcriptMessages, ...this.#loadPartialMessages(sessionId)].sort(
            (left, right) => left.position - right.position,
        );
        const earliestTranscriptPosition = transcriptMessages[0]?.position;
        const hasEarlierTranscript =
            this.#database
                .prepare(
                    earliestTranscriptPosition === undefined
                        ? `
                          SELECT 1
                          FROM session_messages
                          WHERE session_id = ? AND is_partial = 0
                          LIMIT 1
                          `
                        : `
                          SELECT 1
                          FROM session_messages
                          WHERE session_id = ? AND is_partial = 0 AND position < ?
                          LIMIT 1
                          `,
                )
                .get(
                    ...(earliestTranscriptPosition === undefined
                        ? [sessionId]
                        : [sessionId, earliestTranscriptPosition]),
                ) !== undefined;
        const lastMessageAt = readOptionalNumber(row, "last_message_at_ms");
        const modelId = readString(row, "model_id");
        const title = readOptionalString(row, "title");
        const titleError = readOptionalString(row, "title_error");
        const recap = readOptionalString(row, "recap");
        const metadataUpdatedAt = readOptionalNumber(row, "metadata_updated_at_ms");
        const metadataRunId = readOptionalString(row, "metadata_run_id");
        const activeRunId = readOptionalString(row, "active_run_id");
        const activeSince = readOptionalNumber(row, "active_since_ms");
        const contextMessagesJson = readOptionalString(row, "context_messages_json");
        const permissionMode = parsePermissionMode(readString(row, "permission_mode"));
        const parentSessionId = readOptionalString(row, "parent_session_id");
        const parentToolCallId = readOptionalString(row, "parent_tool_call_id");
        const taskName = readOptionalString(row, "task_name");
        const description = readOptionalString(row, "description");
        const goalJson = readOptionalString(row, "goal_json");
        const lastEventId = readOptionalString(row, "last_event_id");
        const id = readString(row, "id");
        const projectId = readString(row, "project_id");
        const workspaceId = readOptionalString(row, "workspace_id");
        const orderKey = readString(row, "order_key");
        const agent: SessionAgentMetadata = {
            depth: readNumber(row, "depth"),
            rootSessionId: readOptionalString(row, "root_session_id") ?? id,
            type: readString(row, "session_kind") as SessionAgentMetadata["type"],
            ...(description !== undefined ? { description } : {}),
            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
            ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
            ...(taskName !== undefined ? { taskName } : {}),
        };
        const restore: PersistedSessionState = {
            ...(activeSince !== undefined ? { activeSince } : {}),
            agent,
            agentId: readString(row, "agent_id"),
            archived,
            archiveOnIdle,
            trackUnread,
            ...(unreadReason !== undefined && unreadSince !== undefined
                ? {
                      unread: {
                          reason: unreadReason as SessionUnreadReason,
                          since: unreadSince,
                      },
                  }
                : {}),
            ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            createdAt: readNumber(row, "created_at_ms"),
            cwd: readString(row, "cwd"),
            ...(draft === undefined ? {} : { draft }),
            ...(draftUpdatedAt === undefined ? {} : { draftUpdatedAt }),
            elapsedMs: readNumber(row, "elapsed_ms"),
            ...(dockerJson !== undefined
                ? { docker: JSON.parse(dockerJson) as DockerExecutionConfig }
                : {}),
            ...(contextMessagesJson !== undefined
                ? { contextMessages: JSON.parse(contextMessagesJson) as Message[] }
                : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(serviceTier === "fast" ? { serviceTier } : {}),
            id,
            ...(instructions !== undefined ? { instructions } : {}),
            ...(goalJson !== undefined ? { goal: JSON.parse(goalJson) as SessionGoal } : {}),
            ...(interruptionJson !== undefined
                ? { interruption: JSON.parse(interruptionJson) as SessionInterruption }
                : {}),
            ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
            messages,
            durableUserInputs: this.#loadDurableUserInputs(sessionId),
            externalToolCalls: this.#loadExternalToolCalls(sessionId),
            externalTools: JSON.parse(
                readString(row, "external_tools_json"),
            ) as ExternalToolDefinition[],
            skills: JSON.parse(readString(row, "durable_skills_json")) as DurableSkillDefinition[],
            modelId,
            models: JSON.parse(readString(row, "models_json")) as Model[],
            orderKey,
            providerId: readString(row, "provider_id"),
            permissionMode,
            projectId,
            ...(workspaceId === undefined ? {} : { workspaceId }),
            secretIds: secretIdsJson === undefined ? [] : (JSON.parse(secretIdsJson) as string[]),
            queuedRuns: this.#loadQueuedRuns(sessionId),
            status: readString(row, "status") as PersistedSessionState["status"],
            tasks: JSON.parse(readString(row, "tasks_json")) as PersistedSessionState["tasks"],
            workflows: JSON.parse(readString(row, "workflows_json")) as PersistedWorkflowRun[],
            workflowsEnabled: readNumber(row, "workflows_enabled") !== 0,
            nextTaskId: readNumber(row, "next_task_id"),
            ...(title !== undefined ? { title } : {}),
            ...(titleError !== undefined ? { titleError } : {}),
            ...(recap !== undefined ? { recap } : {}),
            ...(metadataUpdatedAt !== undefined ? { metadataUpdatedAt } : {}),
            ...(metadataRunId !== undefined ? { metadataRunId } : {}),
            titleStatus: readString(row, "title_status") as SessionTitleStatus,
            transcriptHasEarlier: hasEarlierTranscript,
            totalTokens: readNumber(row, "total_tokens"),
            ...(sessionTokenCountJson === undefined
                ? {}
                : {
                      sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount,
                  }),
            ...(persistedUsage === undefined ? {} : { usage: persistedUsage.committed }),
            ...(persistedUsage?.summary === undefined
                ? {}
                : { usageSummary: persistedUsage.summary }),
            ...(persistedUsage?.throughEventId === undefined
                ? {}
                : { usageSummaryEventId: persistedUsage.throughEventId }),
            ...(persistedUsage?.permissionReviews === undefined
                ? {}
                : { permissionReviews: persistedUsage.permissionReviews }),
            tools: JSON.parse(readString(row, "tools_json")) as string[],
        };
        if (activeRunId !== undefined) {
            restore.activeRunId = activeRunId;
        }

        const request: CreateSessionRequest = {
            ...(restore.appendSystemPrompt !== undefined
                ? { appendSystemPrompt: restore.appendSystemPrompt }
                : {}),
            archiveOnIdle: restore.archiveOnIdle === true,
            trackUnread: restore.trackUnread === true,
            cwd: restore.cwd,
            ...(restore.docker === undefined ? {} : { docker: restore.docker }),
            ...(restore.effort !== undefined ? { effort: restore.effort } : {}),
            ...(restore.serviceTier !== undefined ? { serviceTier: restore.serviceTier } : {}),
            ...(restore.instructions !== undefined ? { instructions: restore.instructions } : {}),
            modelId,
            providerId: restore.providerId,
            secretIds: restore.secretIds ?? [],
            workflowsEnabled: restore.workflowsEnabled !== false,
        };
        return new InMemorySession({
            agentManager: this.#agentManager,
            createEventId: createEventIdFactory(
                lastEventId === undefined ? {} : { after: lastEventId },
            ),
            ...(this.#createRuntime === undefined ? {} : { createRuntime: this.#createRuntime }),
            events: this.#loadEvents(sessionId),
            ...(lastEventId !== undefined ? { lastEventId } : {}),
            modelCatalog: this.#modelCatalog,
            onInitialTitle: (metadata) => this.#inheritWorkspaceTitle(metadata),
            ...(this.#mcpToolProvider !== undefined
                ? { mcpToolProvider: this.#mcpToolProvider }
                : {}),
            onAppendEvent: (event) => this.#appendEvent(event),
            persistence: this,
            projectSecretIds: this.#projectSecrets(projectId),
            projectId,
            request,
            secretRegistry: this.#secrets,
            restore,
            ...(workspaceId === undefined ? {} : { workspaceId }),
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

    #newLastSessionOrderKey(projectId: string, workspaceId: string | undefined): string {
        const items = this.#sessionOrderItems(projectId, workspaceId);
        return generateKeyBetween(items.at(-1)?.orderKey ?? null, null);
    }

    #sessionOrderItems(
        projectId: string,
        workspaceId: string | undefined,
    ): { id: string; orderKey: string }[] {
        const rows =
            workspaceId === undefined
                ? this.#database
                      .prepare(
                          `
                          SELECT id, order_key
                          FROM sessions
                          WHERE parent_session_id IS NULL
                              AND project_id = ?
                              AND workspace_id IS NULL
                          ORDER BY order_key ASC, id ASC
                          `,
                      )
                      .all(projectId)
                : this.#database
                      .prepare(
                          `
                          SELECT id, order_key
                          FROM sessions
                          WHERE parent_session_id IS NULL
                              AND project_id = ?
                              AND workspace_id = ?
                          ORDER BY order_key ASC, id ASC
                          `,
                      )
                      .all(projectId, workspaceId);
        return rows.map((row) => ({
            id: readString(row, "id"),
            orderKey: readString(row, "order_key"),
        }));
    }

    #loadTranscriptMessagesPage(
        sessionId: string,
        turnLimit: number,
        before?: string,
    ): PersistedSessionMessage[] | undefined {
        const runRows = this.#database
            .prepare(
                `
                WITH ordered_runs AS (
                    SELECT run_id, first_position
                    FROM session_turns
                    WHERE session_id = ?
                ),
                anchor AS (
                    SELECT first_position FROM ordered_runs WHERE run_id = ?
                )
                SELECT run_id
                FROM ordered_runs
                WHERE ? IS NULL OR first_position < (SELECT first_position FROM anchor)
                ORDER BY first_position DESC
                LIMIT ?
                `,
            )
            .all(sessionId, before ?? null, before ?? null, turnLimit) as Record<string, unknown>[];
        if (before !== undefined && runRows.length === 0) {
            const known = this.#database
                .prepare(
                    "SELECT 1 FROM session_messages WHERE session_id = ? AND run_id = ? LIMIT 1",
                )
                .get(sessionId, before);
            if (known === undefined) return undefined;
        }
        const runIds = runRows.map((row) => readString(row, "run_id")).reverse();
        if (runIds.length === 0) return [];
        const placeholders = runIds.map(() => "?").join(", ");
        return this.#database
            .prepare(
                `
                SELECT position, is_partial, run_id, message_json
                FROM session_messages
                WHERE session_id = ? AND is_partial = 0 AND run_id IN (${placeholders})
                ORDER BY position ASC
                `,
            )
            .all(sessionId, ...runIds)
            .map((row) => ({
                isPartial: readNumber(row, "is_partial") !== 0,
                message: JSON.parse(readString(row, "message_json")) as Message,
                position: readNumber(row, "position"),
                runId: readString(row, "run_id"),
            }));
    }

    #loadTranscriptMessagesSince(
        sessionId: string,
        turnLimit: number,
        after: EventId,
    ): PersistedSessionMessage[] | undefined {
        const runRows = this.#database
            .prepare(
                `
                WITH anchor_run AS (
                    SELECT turns.first_position
                    FROM session_events AS events
                    JOIN session_messages AS messages
                      ON messages.session_id = events.session_id
                     AND messages.message_id = events.message_id
                     AND messages.is_partial = 0
                    JOIN session_turns AS turns
                      ON turns.session_id = messages.session_id
                     AND turns.run_id = messages.run_id
                    WHERE events.session_id = ? AND events.event_id = ?
                    LIMIT 1
                )
                SELECT turns.run_id
                FROM session_turns AS turns
                WHERE turns.session_id = ?
                  AND turns.first_position >= (SELECT first_position FROM anchor_run)
                ORDER BY turns.first_position ASC
                LIMIT ?
                `,
            )
            .all(sessionId, after, sessionId, turnLimit) as Record<string, unknown>[];
        if (runRows.length === 0) return undefined;
        const runIds = runRows.map((row) => readString(row, "run_id"));
        const placeholders = runIds.map(() => "?").join(", ");
        return this.#database
            .prepare(
                `
                SELECT position, is_partial, run_id, message_json
                FROM session_messages
                WHERE session_id = ? AND is_partial = 0 AND run_id IN (${placeholders})
                ORDER BY position ASC
                `,
            )
            .all(sessionId, ...runIds)
            .map((row) => ({
                isPartial: readNumber(row, "is_partial") !== 0,
                message: JSON.parse(readString(row, "message_json")) as Message,
                position: readNumber(row, "position"),
                runId: readString(row, "run_id"),
            }));
    }

    #transcriptWindowForMessages(
        sessionId: string,
        messages: readonly PersistedSessionMessage[],
        turnLimit: number,
        complete: boolean,
    ): SessionTranscriptWindow | undefined {
        const events = this.#loadTranscriptEvents(sessionId, messages);
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
            ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
        };
    }

    #loadPartialMessages(sessionId: string): PersistedSessionMessage[] {
        return this.#database
            .prepare(
                `
                SELECT position, is_partial, run_id, message_json
                FROM session_messages
                WHERE session_id = ? AND is_partial = 1
                ORDER BY position ASC
                `,
            )
            .all(sessionId)
            .map((row) => {
                const runId = readOptionalString(row, "run_id");
                return {
                    isPartial: true,
                    message: JSON.parse(readString(row, "message_json")) as Message,
                    position: readNumber(row, "position"),
                    ...(runId === undefined ? {} : { runId }),
                };
            });
    }

    #loadTranscriptEvents(
        sessionId: string,
        messages: readonly PersistedSessionMessage[],
    ): SessionEvent[] {
        const runIds = [...new Set(messages.flatMap((entry) => entry.runId ?? []))];
        const messageIds = messages.map((entry) => entry.message.id);
        const toolCallIds = messages.flatMap((entry) =>
            entry.message.blocks.flatMap((block) => (block.type === "tool_call" ? [block.id] : [])),
        );
        const clauses: string[] = [];
        const values: string[] = [];
        const addClause = (column: string, candidates: readonly string[]): void => {
            if (candidates.length === 0) return;
            clauses.push(`${column} IN (${candidates.map(() => "?").join(", ")})`);
            values.push(...candidates);
        };
        addClause("run_id", runIds);
        addClause("message_id", messageIds);
        addClause("tool_call_id", toolCallIds);
        if (clauses.length === 0) return [];
        const rows = this.#database
            .prepare(
                `
                SELECT event_id, type, created_at_ms, data_json
                FROM session_events
                WHERE session_id = ? AND (${clauses.join(" OR ")})
                ORDER BY seq ASC
                `,
            )
            .all(sessionId, ...values);
        return rows.map(
            (row) =>
                ({
                    createdAt: readNumber(row, "created_at_ms"),
                    data: JSON.parse(readString(row, "data_json")) as SessionEvent["data"],
                    id: readString(row, "event_id"),
                    sessionId,
                    type: readString(row, "type") as SessionEvent["type"],
                }) as SessionEvent,
        );
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
        if (workspace !== undefined && workspace.status !== "ready") {
            throw new Error("Only ready workspaces can open terminals.");
        }
        const row =
            scope.workspaceId === undefined
                ? this.#database
                      .prepare(
                          `
                          SELECT docker_json
                          FROM sessions
                          WHERE project_id = ?
                              AND workspace_id IS NULL
                              AND parent_session_id IS NULL
                          ORDER BY updated_at_ms DESC, id DESC
                          LIMIT 1
                          `,
                      )
                      .get(scope.projectId)
                : this.#database
                      .prepare(
                          `
                          SELECT docker_json
                          FROM sessions
                          WHERE project_id = ?
                              AND workspace_id = ?
                              AND parent_session_id IS NULL
                          ORDER BY updated_at_ms DESC, id DESC
                          LIMIT 1
                          `,
                      )
                      .get(scope.projectId, scope.workspaceId);
        const dockerJson = row === undefined ? undefined : readOptionalString(row, "docker_json");
        return {
            cwd: workspace?.path ?? project.path,
            ...(dockerJson === undefined
                ? {}
                : { docker: JSON.parse(dockerJson) as DockerExecutionConfig }),
        };
    }

    #projectSecrets(projectId: string): readonly string[] {
        return this.#database
            .prepare(
                "SELECT secret_id FROM project_secret_attachments WHERE project_id = ? ORDER BY secret_id",
            )
            .all(projectId)
            .map((row) => readString(row, "secret_id"));
    }

    async #recoverProjectWorkspaces(): Promise<void> {
        await this.#projects.reconcileInitializingWorkspaces();
        for (const workspace of this.#projects.listWorkspaces()) {
            if (workspace.status !== "archiving") continue;
            await this.#archiveWorkspace(workspace.projectId, workspace.id);
        }
        // Presence and Git facts are enrichment, so they run only after archival recovery, which is
        // user-visible correctness.
        await this.#projects.reconcileGitFacts();
    }

    #repairInterruptedTitleGenerations(): void {
        this.#database
            .prepare(
                `
                UPDATE sessions
                SET
                    title_status = 'error',
                    title_error = 'Title generation was interrupted because the local server stopped.',
                    updated_at_ms = ?
                WHERE title_status = 'generating'
                `,
            )
            .run(this.#now());
    }

    #transaction<T>(body: () => T): T {
        if (this.#database.isTransaction) return body();
        this.#transactionCommitCallbacks = [];
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const value = body();
            this.#database.exec("COMMIT");
            const callbacks = this.#transactionCommitCallbacks;
            this.#transactionCommitCallbacks = undefined;
            for (const callback of callbacks) {
                try {
                    callback();
                } catch {
                    // The durable transaction already committed; observers are best effort.
                }
            }
            return value;
        } catch (error) {
            this.#transactionCommitCallbacks = undefined;
            if (this.#database.isTransaction) {
                try {
                    this.#database.exec("ROLLBACK");
                } catch {
                    // Preserve the transaction's original failure.
                }
            }
            throw error;
        }
    }

    #afterTransactionCommit(callback: () => void): void {
        if (this.#database.isTransaction) {
            this.#transactionCommitCallbacks?.push(callback);
            return;
        }
        callback();
    }
}

function readNumber(row: Record<string, unknown>, key: string): number {
    const value = row[key];
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "bigint") {
        return Number(value);
    }

    throw new Error(`Expected numeric SQLite column '${key}'.`);
}

function readOptionalString(row: Record<string, unknown>, key: string): string | undefined {
    const value = row[key];
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new Error(`Expected text SQLite column '${key}'.`);
    }
    return value;
}

function readOptionalNumber(row: Record<string, unknown>, key: string): number | undefined {
    const value = row[key];
    if (value === null || value === undefined) {
        return undefined;
    }
    return readNumber(row, key);
}

interface PersistedUsageEnvelope {
    committed: Usage;
    permissionReviews?: PersistedSessionState["permissionReviews"];
    summary?: SessionUsageSummary;
    throughEventId?: EventId;
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

function parsePersistedUsage(value: string | undefined): PersistedUsageEnvelope | undefined {
    if (value === undefined) return undefined;
    const parsed = JSON.parse(value) as Usage | PersistedUsageEnvelope;
    return "committed" in parsed ? parsed : { committed: parsed };
}

function readString(row: Record<string, unknown>, key: string): string {
    const value = readOptionalString(row, key);
    if (value === undefined) {
        throw new Error(`Expected text SQLite column '${key}'.`);
    }
    return value;
}

function readExternalToolCallRow(row: Record<string, unknown>): ExternalToolCall {
    const providerToolCallId = readOptionalString(row, "provider_tool_call_id");
    const resolutionJson = readOptionalString(row, "resolution_json");
    const skillJson = readOptionalString(row, "skill_json");
    const resolvedAt = readOptionalNumber(row, "resolved_at_ms");
    return {
        arguments: JSON.parse(readString(row, "arguments_json")),
        batchId: readString(row, "batch_id"),
        consumed: readNumber(row, "consumed") !== 0,
        createdAt: readNumber(row, "created_at_ms"),
        definition: JSON.parse(readString(row, "definition_json")) as ExternalToolDefinition,
        ...(skillJson === undefined
            ? {}
            : { skill: JSON.parse(skillJson) as DurableSkillDefinition }),
        id: readString(row, "id"),
        runId: readString(row, "run_id"),
        sessionId: readString(row, "session_id"),
        status: readString(row, "status") as ExternalToolCall["status"],
        ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
        toolCallId: readString(row, "tool_call_id"),
        toolCallIndex: readNumber(row, "tool_call_index"),
        ...(resolutionJson === undefined ? {} : { resolution: JSON.parse(resolutionJson) }),
        ...(resolvedAt === undefined ? {} : { resolvedAt }),
    };
}
