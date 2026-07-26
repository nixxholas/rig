import { createEventIdFactory } from "../protocol/index.js";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "../agent/types.js";
import type {
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateProjectWorkspaceRequest,
    CreateSessionRequest,
    ModelCatalog,
    Project,
    ProjectWorkspace,
    ReorderRequest,
    RegisterSecretRequest,
    SecretSummary,
    SessionAgentMetadata,
    SessionSummary,
    SubagentSummary,
} from "../protocol/index.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import { InMemorySession, type InMemorySessionOptions } from "./InMemorySession.js";
import { createModelCatalog } from "./createModelCatalog.js";
import type { SessionStore } from "./SessionStore.js";
import type { McpToolProvider } from "../mcp/index.js";
import { SecretRegistry, type SecretRegistration } from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { ExternalToolCall } from "../external-tools/index.js";
import { initializeSessionDatabase } from "./initializeSessionDatabase.js";
import { InMemoryGlobalEventQueue } from "./InMemoryGlobalEventQueue.js";
import { ProjectRepository, type ProjectAvatarAsset } from "./ProjectRepository.js";
import type { GlobalEventQueue } from "./GlobalEventQueue.js";
import { shouldPublishGlobalEvent } from "./shouldPublishGlobalEvent.js";
import { errorToMessage } from "../errorToMessage.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";

export interface InMemorySessionStoreOptions {
    createRuntime?: InMemorySessionOptions["createRuntime"];
    mcpToolProvider?: McpToolProvider;
    modelCatalog?: ModelCatalog;
    secrets?: readonly SecretRegistration[];
    homeDirectory?: string;
    stateDirectory?: string;
}

export class InMemorySessionStore implements SessionStore {
    #agentManager: AgentSessionManager;
    #createRuntime: InMemorySessionOptions["createRuntime"];
    #modelCatalog: ModelCatalog;
    #mcpToolProvider: McpToolProvider | undefined;
    #projectSecretIds = new Map<string, Set<string>>();
    #database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    readonly #projects: ProjectRepository;
    readonly globalEventQueue = new InMemoryGlobalEventQueue();
    #secrets: SecretRegistry;
    #sessions = new Map<string, InMemorySession>();
    #transactionCommitCallbacks: (() => void)[] | undefined;

    constructor(options: InMemorySessionStoreOptions = {}) {
        initializeSessionDatabase(this.#database);
        this.#projects = new ProjectRepository({
            database: this.#database,
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            onEvent: (event) => this.#publishGlobalEvent(event),
            ...(options.stateDirectory === undefined
                ? {}
                : { stateDirectory: options.stateDirectory }),
            transaction: (body) => this.#transaction(body),
        });
        this.#secrets = new SecretRegistry(options.secrets);
        this.#modelCatalog = options.modelCatalog ?? createModelCatalog();
        this.#createRuntime = options.createRuntime;
        this.#mcpToolProvider = options.mcpToolProvider;
        this.#agentManager = new AgentSessionManager({
            repository: {
                createSubagent: (request, metadata, contextMessages) =>
                    this.#createSession(request, metadata, contextMessages),
                get: (sessionId) => this.get(sessionId),
                listByRoot: (rootSessionId) =>
                    [...this.#sessions.values()].filter(
                        (session) =>
                            session.agentMetadata().rootSessionId === rootSessionId &&
                            session.isSubagent(),
                    ),
            },
        });
    }

    changeEffort(sessionId: string, request: ChangeEffortRequest): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        session.changeEffort(request);
        return session;
    }

    attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        this.#secrets.reference(secretId);
        if (scope === "project") {
            const projectId = session.snapshot().projectId;
            const ids = this.#projectSecretIds.get(projectId) ?? new Set<string>();
            ids.add(secretId);
            this.#projectSecretIds.set(projectId, ids);
            for (const candidate of this.#sessions.values()) {
                if (candidate.snapshot().projectId === projectId) {
                    candidate.attachSecret(secretId, { scope });
                }
            }
        } else {
            session.attachSecret(secretId, { scope });
        }
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

    create(request: CreateSessionRequest): InMemorySession {
        return this.#createSession(request);
    }

    detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
    ): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        if (scope === "project") {
            const projectId = session.snapshot().projectId;
            this.#projectSecretIds.get(projectId)?.delete(secretId);
            for (const candidate of this.#sessions.values()) {
                if (candidate.snapshot().projectId === projectId) {
                    candidate.detachSecret(secretId, { scope });
                }
            }
        } else {
            session.detachSecret(secretId, { scope });
        }
        return session;
    }

    fork(sessionId: string): InMemorySession | undefined {
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
        const session = new InMemorySession({
            agentManager: this.#agentManager,
            createEventId: createEventIdFactory(),
            ...(this.#createRuntime === undefined ? {} : { createRuntime: this.#createRuntime }),
            modelCatalog: this.#modelCatalog,
            ...(this.#mcpToolProvider !== undefined
                ? { mcpToolProvider: this.#mcpToolProvider }
                : {}),
            request: source.requestForSubagent(),
            onAppendEvent: (event) => this.#publishGlobalEvent(event),
            projectId: sourceSnapshot.projectId,
            projectSecretIds: this.#projectSecrets(sourceSnapshot.projectId),
            secretRegistry: this.#secrets,
            restore: {
                ...state,
                orderKey: this.#newLastSessionOrderKey(
                    sourceSnapshot.projectId,
                    sourceSnapshot.workspaceId,
                ),
            },
            ...(sourceSnapshot.workspaceId === undefined
                ? {}
                : { workspaceId: sourceSnapshot.workspaceId }),
        });
        this.#sessions.set(session.id, session);
        session.emitCreatedEvent();
        return session;
    }

    #createSession(
        request: CreateSessionRequest,
        metadata?: SessionAgentMetadata,
        contextMessages?: readonly Message[],
    ): InMemorySession {
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
        const session = new InMemorySession({
            agentManager: this.#agentManager,
            createEventId: createEventIdFactory(),
            ...(this.#createRuntime === undefined ? {} : { createRuntime: this.#createRuntime }),
            modelCatalog: this.#modelCatalog,
            ...(this.#mcpToolProvider !== undefined
                ? { mcpToolProvider: this.#mcpToolProvider }
                : {}),
            ...(metadata !== undefined ? { metadata } : {}),
            ...(contextMessages !== undefined ? { initialContextMessages: contextMessages } : {}),
            onAppendEvent: (event) => this.#publishGlobalEvent(event),
            orderKey:
                inherited === undefined
                    ? this.#newLastSessionOrderKey(ownership.project.id, ownership.workspace?.id)
                    : generateKeyBetween(null, null),
            projectId: ownership.project.id,
            projectSecretIds: this.#projectSecrets(ownership.project.id),
            request,
            secretRegistry: this.#secrets,
            ...(ownership.workspace === undefined ? {} : { workspaceId: ownership.workspace.id }),
        });
        this.#sessions.set(session.id, session);
        return session;
    }

    get(sessionId: string): InMemorySession | undefined {
        return this.#sessions.get(sessionId);
    }

    list(options: { limit?: number } = {}): readonly SessionSummary[] {
        const projectOrder = new Map(
            this.#projects.listProjects().map((project) => [project.id, project.orderKey]),
        );
        const workspaceOrder = new Map(
            this.#projects.listWorkspaces().map((workspace) => [workspace.id, workspace.orderKey]),
        );
        const sessions = [...this.#sessions.values()]
            .filter((session) => !session.isSubagent())
            .map((session) => session.summary())
            .sort((left, right) => sortSummariesByOrder(left, right, projectOrder, workspaceOrder));
        return options.limit === undefined ? sessions : sessions.slice(0, options.limit);
    }

    listExternalToolCalls(
        options: { limit?: number; status?: ExternalToolCall["status"] } = {},
    ): readonly ExternalToolCall[] {
        return [...this.#sessions.values()]
            .flatMap((session) =>
                session.externalToolCalls(
                    options.status === undefined ? {} : { status: options.status },
                ),
            )
            .sort((left, right) => left.createdAt - right.createdAt)
            .slice(0, options.limit ?? 100);
    }

    listSubagents(parentSessionId: string): readonly SubagentSummary[] {
        return [...this.#sessions.values()]
            .filter((session) => {
                let ancestorId = session.agentMetadata().parentSessionId;
                while (ancestorId !== undefined) {
                    if (ancestorId === parentSessionId) return true;
                    ancestorId = this.#sessions.get(ancestorId)?.agentMetadata().parentSessionId;
                }
                return false;
            })
            .map((session) => session.subagentSummary())
            .sort((left, right) => left.createdAt - right.createdAt);
    }

    listSecrets(): readonly SecretSummary[] {
        return this.#secrets.references();
    }

    registerSecret(request: RegisterSecretRequest): SecretSummary {
        this.#secrets.register(request);
        return this.#secrets.reference(request.id);
    }

    unregisterSecret(secretId: string): boolean {
        const removed = this.#secrets.unregister(secretId);
        if (!removed) return false;
        for (const ids of this.#projectSecretIds.values()) ids.delete(secretId);
        for (const session of this.#sessions.values()) {
            session.detachSecret(secretId, { scope: "project" });
            session.detachSecret(secretId, { scope: "session" });
        }
        return true;
    }

    getProject(projectId: string): Project | undefined {
        return this.#projects.getProject(projectId);
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

    renameProject(projectId: string, name: string): Project | undefined {
        return this.#projects.renameProject(projectId, name);
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
        const session = this.get(sessionId);
        if (session === undefined) return undefined;
        if (session.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        const snapshot = session.snapshot();
        const siblings = [...this.#sessions.values()]
            .filter((candidate) => {
                if (candidate.isSubagent()) return false;
                const candidateSnapshot = candidate.snapshot();
                return (
                    candidateSnapshot.projectId === snapshot.projectId &&
                    candidateSnapshot.workspaceId === snapshot.workspaceId
                );
            })
            .map((candidate) => candidate.summary());
        session.setOrderKey(orderKeyAfter(siblings, sessionId, request.afterId));
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
    ): ProjectWorkspace | undefined {
        return this.#projects.renameWorkspace(projectId, workspaceId, name, expectedVersion);
    }

    createWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspace | undefined> {
        return this.#projects.createWorkspace(projectId, request);
    }

    /*
     * Archiving a project hides the whole folder: its root chats are archived, and every managed
     * workspace is archived with the sessions and worktree directory it owns.
     */
    async archiveProject(
        projectId: string,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        const project = this.#projects.archiveProject(projectId, expectedVersion);
        if (project === undefined) return undefined;
        for (const session of this.#sessions.values()) {
            if (session.isSubagent()) continue;
            const snapshot = session.snapshot();
            if (snapshot.projectId !== projectId || snapshot.workspaceId !== undefined) continue;
            session.setArchived(true);
        }
        for (const workspace of this.#projects.listWorkspaces(projectId)) {
            if (workspace.status === "archived" || workspace.status === "archiving") continue;
            await this.archiveWorkspace(projectId, workspace.id);
        }
        return this.getProject(projectId);
    }

    unarchiveProject(projectId: string): Project | undefined {
        return this.#projects.unarchiveProject(projectId);
    }

    async archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined> {
        const workspace = this.#projects.beginWorkspaceArchive(
            projectId,
            workspaceId,
            expectedVersion,
        );
        if (workspace === undefined || workspace.status === "archived") return workspace;
        const cleanup = [...this.#sessions.values()]
            .filter((session) => session.snapshot().workspaceId === workspaceId)
            .map((session) => session.archiveForWorkspace(workspaceId));
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

    changeModel(sessionId: string, request: ChangeModelRequest): InMemorySession | undefined {
        const session = this.get(sessionId);
        if (session === undefined) {
            return undefined;
        }

        session.changeModel(request);
        return session;
    }

    #projectSecrets(projectId: string): readonly string[] {
        return [...(this.#projectSecretIds.get(projectId) ?? [])];
    }

    #newLastSessionOrderKey(projectId: string, workspaceId: string | undefined): string {
        const last = [...this.#sessions.values()]
            .filter((session) => {
                if (session.isSubagent()) return false;
                const snapshot = session.snapshot();
                return snapshot.projectId === projectId && snapshot.workspaceId === workspaceId;
            })
            .map((session) => session.summary())
            .sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey))
            .at(-1);
        return generateKeyBetween(last?.orderKey ?? null, null);
    }

    #publishGlobalEvent(event: Parameters<GlobalEventQueue["append"]>[0]): void {
        if (!shouldPublishGlobalEvent(event)) return;
        this.#afterTransactionCommit(() => {
            const entry = this.globalEventQueue.append(event);
            if (entry !== undefined) this.globalEventQueue.publish(entry);
        });
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
                    // The project transaction already committed; observers are best effort.
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

function compareOrderKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sortSummariesByOrder(
    left: SessionSummary,
    right: SessionSummary,
    projectOrder: ReadonlyMap<string, string>,
    workspaceOrder: ReadonlyMap<string, string>,
): number {
    return (
        compareOrderKeys(
            projectOrder.get(left.projectId) ?? "",
            projectOrder.get(right.projectId) ?? "",
        ) ||
        Number(left.workspaceId !== undefined) - Number(right.workspaceId !== undefined) ||
        compareOrderKeys(
            left.workspaceId === undefined ? "" : (workspaceOrder.get(left.workspaceId) ?? ""),
            right.workspaceId === undefined ? "" : (workspaceOrder.get(right.workspaceId) ?? ""),
        ) ||
        compareOrderKeys(left.orderKey, right.orderKey) ||
        compareOrderKeys(left.id, right.id)
    );
}
