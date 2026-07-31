import { createId } from "@paralleldrive/cuid2";

import {
    createSubagentInstructions,
    findLastAgentResponseText,
    type ChatHistoryRole,
    type ChatHistoryPage,
    type AgentCommunicationContext,
    type AgentCommunicationInfo,
    selectChatHistoryPage,
    type ManagedSubagent,
    type SpawnSubagentRequest,
    type SpawnSubagentResult,
    type SubagentRunStatus,
    type WaitForSubagentResult,
} from "../agent/index.js";
import { DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS } from "../agent/context/subagentWaitTimeouts.js";
import { isCodexV2CollaborationModel } from "../agent/tools/codex/isCodexV2CollaborationModel.js";
import type {
    CreateProjectWorkspaceRequest,
    CreateSessionRequest,
    Project,
    ProjectWorkspace,
    SessionAgentMetadata,
} from "../protocol/index.js";
import type {
    AgentProject,
    AgentWorkspace,
    AgentWorkspaceSession,
    DelegatedSession,
    DelegatedSessionRequest,
} from "../agent/context/WorkspaceContext.js";
import type { Message } from "../agent/types.js";
import type { PermissionMode } from "../permissions/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import { resolveSharedAgentPath } from "./impl/resolveSharedAgentPath.js";
import type { InMemorySession } from "./InMemorySession.js";

export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 8;
export const DEFAULT_MAX_ACTIVE_CODEX_V2_SUBAGENTS = 3;

export interface AgentSessionRepository {
    archiveOwnedWorkspace?(
        ownerSessionId: string,
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined>;
    createOwnedWorkspace?(
        ownerSessionId: string,
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspace | undefined>;
    createSubagent(
        request: CreateSessionRequest,
        metadata: SessionAgentMetadata,
        contextMessages?: readonly Message[],
    ): InMemorySession;
    createDelegatedSession?(
        request: CreateSessionRequest,
        metadata: SessionAgentMetadata,
        id: string,
    ): InMemorySession;
    findByAgentId?(agentId: string): InMemorySession | undefined;
    get(sessionId: string): InMemorySession | undefined;
    listByRoot(rootSessionId: string): readonly InMemorySession[];
    listProjects?(): readonly Project[];
    listProjectWorkspaces?(projectId: string): readonly ProjectWorkspace[];
    listProjectSessions?(target: {
        projectId: string;
        workspaceId?: string;
    }): readonly AgentWorkspaceSession[];
    ownedWorkspace?(
        ownerSessionId: string,
        projectId: string,
        workspaceId: string,
    ): ProjectWorkspace | undefined;
    workspace?(projectId: string, workspaceId: string): ProjectWorkspace | undefined;
}

export interface AgentSessionManagerOptions {
    maxActive?: number;
    maxDepth?: number;
    repository: AgentSessionRepository;
    taskDrain?: TaskDrain;
}

export class AgentSessionManager {
    readonly maxActive: number;
    readonly maxDepth: number;

    readonly #repository: AgentSessionRepository;
    readonly #lastSuccessfulModelByProvider = new Map<string, string>();
    readonly #lastSuccessfulProviderByModel = new Map<string, string>();
    readonly #latestBackgroundRunBySession = new Map<string, string>();
    readonly #pendingBackgroundRuns = new Map<string, string>();
    readonly #slotReservations = new Map<string, number>();
    readonly #stoppedExplicitly = new Set<string>();
    readonly #taskDrain: TaskDrain | undefined;

    constructor(options: AgentSessionManagerOptions) {
        this.#repository = options.repository;
        this.#taskDrain = options.taskDrain;
        this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE_SUBAGENTS;
        this.maxDepth = options.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
    }

    taskSession(sessionId: string): InMemorySession | undefined {
        const session = this.#repository.get(sessionId);
        if (session === undefined) return undefined;
        return this.#repository.get(session.agentMetadata().rootSessionId) ?? session;
    }

    maxActiveFor(rootSessionId: string): number {
        const root = this.#repository.get(rootSessionId);
        return root?.isCodexV2Collaboration?.() === true
            ? Math.min(this.maxActive, DEFAULT_MAX_ACTIVE_CODEX_V2_SUBAGENTS)
            : this.maxActive;
    }

    recordChanged(child: InMemorySession): void {
        let parent = this.#parentFor(child);
        while (parent !== undefined) {
            parent.recordSubagentChanged(child.subagentSummary());
            parent = this.#parentFor(parent);
        }
    }

    recordSuccessfulProvider(modelId: string, providerId: string): void {
        this.#lastSuccessfulModelByProvider.set(providerId, modelId);
        this.#lastSuccessfulProviderByModel.set(modelId, providerId);
    }

    async createWorkspace(
        ownerSessionId: string,
        input: { baseRef: string; name: string },
    ): Promise<ProjectWorkspace> {
        const owner = this.#repository.get(ownerSessionId);
        const create = this.#repository.createOwnedWorkspace;
        if (owner === undefined || create === undefined) {
            throw new Error("This session cannot create managed workspaces.");
        }
        if (owner.isSubagent()) {
            throw new Error("Only a primary session can create a managed workspace.");
        }
        const workspace = await create(ownerSessionId, owner.snapshot().projectId, input);
        if (workspace === undefined) throw new Error("The workspace could not be created.");
        return workspace;
    }

    async archiveWorkspace(ownerSessionId: string, workspaceId: string): Promise<ProjectWorkspace> {
        const owner = this.#repository.get(ownerSessionId);
        const archive = this.#repository.archiveOwnedWorkspace;
        if (owner === undefined || archive === undefined) {
            throw new Error("This session cannot archive managed workspaces.");
        }
        const workspace = await archive(ownerSessionId, owner.snapshot().projectId, workspaceId);
        if (workspace === undefined) {
            throw new Error("This workspace was not created by the current session.");
        }
        return workspace;
    }

    listProjects(sessionId: string): readonly AgentProject[] {
        const list = this.#repository.listProjects;
        if (list === undefined) throw new Error("This session cannot list projects.");
        const currentProjectId = this.#current(sessionId).snapshot().projectId;
        return list().map((project) => ({
            current: project.id === currentProjectId,
            id: project.id,
            name: project.name,
            path: project.path,
        }));
    }

    listWorkspaces(
        sessionId: string,
        projectId: string | undefined,
        options: { crossWorkspace: boolean },
    ): readonly AgentWorkspace[] {
        const list = this.#repository.listProjectWorkspaces;
        if (list === undefined) throw new Error("This session cannot list workspaces.");
        const target = this.#targetProjectId(sessionId, projectId, options);
        return list(target).map((workspace) => this.#agentWorkspace(sessionId, workspace));
    }

    listSessions(
        sessionId: string,
        target: { projectId?: string; workspaceId?: string },
        options: { crossWorkspace: boolean },
    ): readonly AgentWorkspaceSession[] {
        const list = this.#repository.listProjectSessions;
        if (list === undefined) throw new Error("This session cannot list conversations.");
        const projectId = this.#targetProjectId(sessionId, target.projectId, options);
        return list({
            projectId,
            ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
        });
    }

    /**
     * Starts a user-visible conversation in another workspace on behalf of a session.
     *
     * The new session is a primary one: it holds its own place in the session list and the user
     * may take it over. The delegator is recorded so it can be told when they do, and it talks to
     * the session afterwards through the ordinary agent messaging tools.
     */
    async delegate(
        delegatorSessionId: string,
        request: DelegatedSessionRequest,
    ): Promise<DelegatedSession> {
        const delegator = this.#current(delegatorSessionId);
        const create = this.#repository.createDelegatedSession;
        const resolveWorkspace = this.#repository.workspace;
        if (create === undefined || resolveWorkspace === undefined) {
            throw new Error("This session cannot start work in another workspace.");
        }
        if (delegator.isSubagent()) {
            throw new Error("Only a primary session can start work in another workspace.");
        }
        const snapshot = delegator.snapshot();
        const projectId = request.projectId ?? snapshot.projectId;
        const workspace = await this.#waitForWorkspace(() =>
            resolveWorkspace(projectId, request.workspaceId),
        );
        if (workspace === undefined) {
            throw new Error("That workspace was not found in that project.");
        }
        if (workspace.status !== "ready") {
            throw new Error(`The workspace is ${workspace.status} and cannot start work yet.`);
        }
        if (workspace.id === snapshot.workspaceId) {
            throw new Error("That workspace is the one this session already works in.");
        }
        const sessionId = createId();
        const delegate = create(
            {
                ...delegator.requestForSubagent(),
                cwd: workspace.path,
                projectId,
                trackUnread: true,
                workspaceId: workspace.id,
            },
            {
                delegatedBySessionId: delegatorSessionId,
                depth: 0,
                rootSessionId: sessionId,
                type: "primary",
                ...(request.title === undefined ? {} : { description: request.title }),
            },
            sessionId,
        );
        const submitted = delegate.submit({
            agentMessageTriggerTurn: true,
            provenance: "agent",
            text: request.prompt,
        });
        this.#startDelegatedRunMonitor(delegator, delegate, submitted.runId);
        return {
            agentId: delegate.agentIdentity().agentId,
            projectId,
            sessionId: delegate.id,
            title: request.title ?? "Untitled conversation",
            workspaceId: workspace.id,
            workspacePath: workspace.path,
        };
    }

    /**
     * Tells a delegator that the user has taken their delegated session over.
     *
     * The delegator keeps working, but it must not assume it is still the only voice in that
     * conversation, so it is given what the user actually said.
     */
    notifyDelegatorOfUserMessage(sessionId: string, text: string): void {
        const delegate = this.#repository.get(sessionId);
        const delegatorSessionId = delegate?.agentMetadata().delegatedBySessionId;
        if (delegate === undefined || delegatorSessionId === undefined) return;
        const delegator = this.#repository.get(delegatorSessionId);
        if (delegator === undefined || delegator.isClosing?.() === true) return;
        const title = delegate.agentIdentity().title ?? "the delegated conversation";
        try {
            delegator.deliverNotification({
                displayText: `The user replied in "${title}" themselves.`,
                text: [
                    "<delegated-session-notification>",
                    `Session: ${delegate.id}`,
                    `Agent ID: ${delegate.agentIdentity().agentId}`,
                    `Title: ${title}`,
                    "The user wrote to this delegated session directly. They are steering it now.",
                    "User message:",
                    text,
                    "</delegated-session-notification>",
                ].join("\n"),
            });
        } catch (error) {
            // Reaching the delegator is best effort; a delegator that cannot take the news must
            // not break the user's own message. A database that cannot record it still must.
            if (isDatabaseFailure(error)) throw error;
        }
    }

    #targetProjectId(
        sessionId: string,
        projectId: string | undefined,
        options: { crossWorkspace: boolean },
    ): string {
        const currentProjectId = this.#current(sessionId).snapshot().projectId;
        if (projectId === undefined || projectId === currentProjectId) return currentProjectId;
        if (!options.crossWorkspace) {
            throw new Error(
                "Looking into another project is turned off. Ask the user to enable features.cross_workspace in their Rig configuration.",
            );
        }
        return projectId;
    }

    #agentWorkspace(sessionId: string, workspace: ProjectWorkspace): AgentWorkspace {
        const owned =
            this.#repository.ownedWorkspace?.(sessionId, workspace.projectId, workspace.id) !==
            undefined;
        return {
            id: workspace.id,
            name: workspace.name,
            path: workspace.path,
            projectId: workspace.projectId,
            status: workspace.status,
            ...(owned ? { owned } : {}),
        };
    }

    #startDelegatedRunMonitor(
        delegator: InMemorySession,
        delegate: InMemorySession,
        runId: string,
    ): void {
        const monitor = async () => {
            const completion = await delegate.waitForRun(runId);
            if (delegator.isClosing?.() === true) return;
            const title = delegate.agentIdentity().title ?? "the delegated conversation";
            const output = this.#completionOutput(
                delegate,
                completion.status,
                completion.errorMessage,
            );
            delegator.deliverNotification({
                displayText: `Delegated work in "${title}" ${
                    completion.status === "completed"
                        ? "completed"
                        : completion.status === "aborted"
                          ? "was stopped"
                          : "failed"
                }.`,
                text: [
                    "<delegated-session-notification>",
                    `Session: ${delegate.id}`,
                    `Agent ID: ${delegate.agentIdentity().agentId}`,
                    `Title: ${title}`,
                    `Status: ${completion.status}`,
                    `Result: ${output}`,
                    "</delegated-session-notification>",
                ].join("\n"),
            });
        };
        const task = this.#taskDrain?.run(monitor) ?? monitor();
        void task.catch((error: unknown) => {
            if (isDatabaseFailure(error)) throw error;
        });
    }

    async spawnInWorkspace(
        parentSessionId: string,
        request: Omit<SpawnSubagentRequest, "cwd" | "workspaceId"> & { workspaceId: string },
        signal?: AbortSignal,
    ): Promise<SpawnSubagentResult> {
        const parent = this.#repository.get(parentSessionId);
        const resolveWorkspace = this.#repository.ownedWorkspace;
        if (parent === undefined || resolveWorkspace === undefined) {
            throw new Error("This session cannot start workspace agents.");
        }
        const projectId = parent.snapshot().projectId;
        const workspace = await this.#waitForWorkspace(
            () => resolveWorkspace(parentSessionId, projectId, request.workspaceId),
            signal,
        );
        if (workspace === undefined) {
            throw new Error("This workspace was not created by the current session.");
        }
        if (workspace.status !== "ready") {
            throw new Error(`The workspace is ${workspace.status} and cannot start an agent yet.`);
        }
        return this.spawn(
            parentSessionId,
            { ...request, cwd: workspace.path, workspaceId: workspace.id },
            signal,
        );
    }

    /**
     * Waits out the moments between a workspace being created and its worktree being usable, so an
     * agent that just made one does not have to poll for it before starting work there.
     */
    async #waitForWorkspace(
        resolveWorkspace: () => ProjectWorkspace | undefined,
        signal?: AbortSignal,
    ): Promise<ProjectWorkspace | undefined> {
        for (;;) {
            signal?.throwIfAborted();
            const workspace = resolveWorkspace();
            if (workspace === undefined || workspace.status !== "initializing") {
                return workspace;
            }
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(signal?.reason);
                };
                const timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, 100);
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    }

    communicationContext(sessionId: string): AgentCommunicationContext {
        const inspectedAgentIds = new Set<string>();
        return {
            info: (agentId) => {
                const info = this.#info(sessionId, agentId);
                inspectedAgentIds.add(agentId);
                return info;
            },
            me: () => this.#current(sessionId).agentIdentity(),
            send: (agentId, message) => {
                if (!inspectedAgentIds.has(agentId)) {
                    throw new Error(
                        "Call agent_info with this agent ID before sending it a message.",
                    );
                }
                return this.#sendToAgent(sessionId, agentId, message);
            },
        };
    }

    sendScheduledMessage(
        senderSessionId: string,
        targetAgentId: string,
        message: string,
        messageId: string,
    ): void {
        this.#sendToAgent(senderSessionId, targetAgentId, message, messageId);
    }

    async changeSubagentPermissionModes(
        parentSessionId: string,
        permissionMode: PermissionMode,
    ): Promise<void> {
        const root = this.#rootFor(parentSessionId);
        const results = await Promise.allSettled(
            this.#repository.listByRoot(root.id).map(async (session) => {
                try {
                    await session.changePermissionMode(
                        { permissionMode },
                        { updateSubagents: false },
                    );
                } catch (error) {
                    try {
                        await session.beginShutdown();
                    } catch (shutdownError) {
                        throw new AggregateError(
                            [error, shutdownError],
                            `Could not reduce permissions or stop descendant ${session.id}.`,
                        );
                    }
                    throw error;
                }
            }),
        );
        const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
            throw new AggregateError(errors, "Could not update every descendant permission mode.");
        }
    }

    followUp(
        parentSessionId: string,
        target: string,
        message: string,
        effort?: string,
        encryptedMessage?: string,
    ): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const parent = this.#repository.get(parentSessionId);
        if (encryptedMessage !== undefined) {
            const parentTransportScope = parent?.encryptedAgentTransportScope();
            if (
                parentTransportScope === undefined ||
                parentTransportScope !== child.encryptedAgentTransportScope()
            ) {
                throw new Error(
                    "Native encrypted collaboration only works within the same compatible provider and region. Retry with `rig.followup_task` and provide the task normally.",
                );
            }
        }
        const childStatus = child.subagentSummary().status;
        if (childStatus !== "running" && childStatus !== "queued") {
            this.#assertTurnSlotAvailable(child.agentMetadata().rootSessionId);
        }
        if (childStatus === "suspended") child.clearSuspension();
        this.#stoppedExplicitly.delete(child.id);
        const childPath = this.#pathFor(child);
        const parentPath = parent === undefined ? "/root" : this.#pathFor(parent);
        const submitted = child.submit({
            agentMessageTriggerTurn: true,
            ...(this.#repository.get(parentSessionId)?.activeRunDebug?.() === true
                ? { debug: true }
                : {}),
            ...(effort === undefined ? {} : { effort }),
            ...(encryptedMessage === undefined
                ? {}
                : {
                      encryptedAgentMessage: {
                          author: parentPath,
                          recipient: childPath,
                          header: `Message Type: NEW_TASK\nTask name: ${childPath}\nSender: ${parentPath}\nPayload:\n`,
                          encryptedContent: encryptedMessage,
                      },
                      displayText: `Follow-up task for ${child.subagentSummary().taskName}`,
                  }),
            provenance: "agent",
            text: message,
        });
        const childParent = this.#parentFor(child);
        this.recordChanged(child);
        this.#startBackgroundMonitor(childParent, child, submitted.runId);
        return this.#managedSubagent(child);
    }

    sendMessage(
        parentSessionId: string,
        target: string,
        message: string,
        encryptedMessage?: string,
    ): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const parent = this.#repository.get(parentSessionId);
        if (encryptedMessage !== undefined) {
            const parentTransportScope = parent?.encryptedAgentTransportScope();
            if (
                parentTransportScope === undefined ||
                parentTransportScope !== child.encryptedAgentTransportScope()
            ) {
                throw new Error(
                    "Native encrypted collaboration only works within the same compatible provider and region.",
                );
            }
        }
        const childPath = this.#pathFor(child);
        const parentPath = parent === undefined ? "/root" : this.#pathFor(parent);
        child.deliverAgentMessage({
            blocks: message.length === 0 ? [] : [{ type: "text", text: message }],
            id: crypto.randomUUID(),
            provenance: "agent",
            role: "user",
            ...(encryptedMessage === undefined
                ? {}
                : {
                      encryptedAgentMessage: {
                          author: parentPath,
                          recipient: childPath,
                          header: `Message Type: MESSAGE\nTask name: ${childPath}\nSender: ${parentPath}\nPayload:\n`,
                          encryptedContent: encryptedMessage,
                      },
                  }),
        });
        this.recordChanged(child);
        return this.#managedSubagent(child);
    }

    interrupt(parentSessionId: string, target: string): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const previous = this.#managedSubagent(child);
        void this.stopDescendants(child.id);
        if (child.subagentSummary().status === "suspended") child.clearSuspension();
        void Promise.resolve(child.abort({ stopDescendants: false })).catch(rethrowDatabaseFailure);
        this.recordChanged(child);
        return previous;
    }

    inspect(parentSessionId: string, target: string): ManagedSubagent {
        const child = this.#resolveTarget(parentSessionId, target);
        const agent = this.#managedSubagent(child);
        if (
            agent.status === "completed" ||
            agent.status === "error" ||
            agent.status === "aborted"
        ) {
            return {
                ...agent,
                output: this.#completionOutput(
                    child,
                    agent.status,
                    agent.status === "error" ? child.lastErrorMessage() : undefined,
                ),
            };
        }
        return agent;
    }

    async pauseDescendants(parentSessionId: string): Promise<number> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return 0;
        const active = this.#activeDescendantsOf(parentSessionId).filter(
            (child) => !this.#belongsToRunningWorkflow(child, parent),
        );
        await Promise.all(
            active.map(async (child) => {
                await child.suspendByParent();
                this.recordChanged(child);
            }),
        );
        parent.recordSubagentsSuspended(active.map((child) => this.#managedSubagent(child)));
        return active.length;
    }

    async stopDescendants(parentSessionId: string): Promise<number> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return 0;
        // Workflows are independently managed background runs. Interrupting the parent can
        // cancel a wait for one, but only stopWorkflow, reset, or shutdown should stop its agents.
        const descendants = this.#descendantsOf(parentSessionId).filter(
            (child) => !this.#belongsToRunningWorkflow(child, parent),
        );
        const active = descendants.filter((child) => {
            const status = child.subagentSummary().status;
            return status === "queued" || status === "running";
        });
        const suspended = descendants.filter(
            (child) => child.subagentSummary().status === "suspended",
        );
        for (const child of suspended) {
            child.clearSuspension();
            this.recordChanged(child);
        }
        for (const child of active) this.#stoppedExplicitly.add(child.id);
        await Promise.all(
            active.map(async (child) => {
                await child.abort({ stopDescendants: false });
                this.recordChanged(child);
            }),
        );
        return active.length + suspended.length;
    }

    list(parentSessionId: string, pathPrefix?: string): readonly ManagedSubagent[] {
        const root = this.#rootFor(parentSessionId);
        const agents = this.#repository
            .listByRoot(root.id)
            .filter((session) => session.isSubagent())
            .map((session) => this.#managedSubagent(session))
            .sort((left, right) => left.path.localeCompare(right.path));
        return pathPrefix === undefined
            ? agents
            : agents.filter((agent) => agent.path.startsWith(pathPrefix));
    }

    readChatHistory(
        currentSessionId: string,
        options: {
            cursor?: number;
            from?: "end" | "start";
            limit: number;
            query?: string;
            roles?: readonly ChatHistoryRole[];
            target?: string;
        },
    ): ChatHistoryPage {
        const current = this.#repository.get(currentSessionId);
        if (current === undefined) throw new Error("The current session is no longer available.");
        const root = this.#rootFor(currentSessionId);
        const sessions = [root, ...this.#repository.listByRoot(root.id)];
        const target = (() => {
            if (options.target === undefined || options.target === "current") return current;
            const matches = sessions.filter((session) => {
                const metadata = session.agentMetadata();
                return (
                    session.id === options.target ||
                    metadata.taskName === options.target ||
                    this.#pathFor(session) === options.target
                );
            });
            if (matches.length === 0) {
                throw new Error(`Agent '${options.target}' was not found in this session tree.`);
            }
            if (matches.length > 1) {
                throw new Error(`Agent name '${options.target}' is ambiguous. Use its full path.`);
            }
            return matches[0] as InMemorySession;
        })();
        const agents = sessions
            .map((session) => {
                const snapshot = session.snapshot();
                return {
                    ...(snapshot.agent.description === undefined
                        ? {}
                        : { description: snapshot.agent.description }),
                    messageCount: snapshot.snapshot.messages.length,
                    path: this.#pathFor(session),
                    sessionId: session.id,
                    status: snapshot.status,
                };
            })
            .sort((left, right) => left.path.localeCompare(right.path));
        const messages = target.snapshot().snapshot.messages;
        return {
            agent: agents.find((agent) => agent.sessionId === target.id) as (typeof agents)[number],
            agents,
            ...selectChatHistoryPage(messages, options),
        };
    }

    hasActiveDescendantWork(rootSessionId: string): boolean {
        return this.#repository
            .listByRoot(rootSessionId)
            .some((session) => session.hasLocalSettlementWork());
    }

    recordDescendantSettlementActivity(rootSessionId: string): void {
        this.#repository.get(rootSessionId)?.recordDescendantActivity();
    }

    async spawn(
        parentSessionId: string,
        request: SpawnSubagentRequest,
        signal?: AbortSignal,
    ): Promise<SpawnSubagentResult> {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) {
            throw new Error("The parent session is no longer available.");
        }
        if (
            request.encryptedPrompt !== undefined &&
            (parent.encryptedAgentTransportScope() === undefined ||
                request.providerId !== undefined ||
                (request.modelId !== undefined && !isCodexV2CollaborationModel(request.modelId)))
        ) {
            throw new Error(
                "Native encrypted collaboration only works within the current compatible provider and region. Use `rig.spawn_agent` and provide the task normally when selecting or crossing a model, provider, or region.",
            );
        }
        let parentRequest: CreateSessionRequest | undefined;
        let childModelId = request.modelId;
        let childProviderId = request.providerId;
        if (childModelId !== undefined) {
            parentRequest = parent.requestForSubagent();
            if (childProviderId !== undefined && !parent.hasModel(childModelId, childProviderId)) {
                throw new Error(
                    `Model '${childModelId}' is not available for provider '${childProviderId}'.`,
                );
            }
            if (childProviderId === undefined) {
                const currentProviderId = parentRequest.providerId;
                const lastSuccessfulProviderId =
                    this.#lastSuccessfulProviderByModel.get(childModelId);
                if (
                    lastSuccessfulProviderId !== undefined &&
                    parent.hasModel(childModelId, lastSuccessfulProviderId)
                ) {
                    childProviderId = lastSuccessfulProviderId;
                } else if (
                    currentProviderId !== undefined &&
                    parent.hasModel(childModelId, currentProviderId)
                ) {
                    childProviderId = currentProviderId;
                } else {
                    const matchingProviderIds = parent.providerIdsForModel(childModelId);
                    if (matchingProviderIds.length === 0) {
                        throw new Error(`Model '${childModelId}' is not available.`);
                    }
                    childProviderId = matchingProviderIds[0];
                }
            }
        } else if (childProviderId !== undefined) {
            parentRequest = parent.requestForSubagent();
            const providerModelIds = parent.modelIdsForProvider(childProviderId);
            if (providerModelIds.length === 0) {
                throw new Error(`Provider '${childProviderId}' is not available.`);
            }
            const lastSuccessfulModelId = this.#lastSuccessfulModelByProvider.get(childProviderId);
            childModelId =
                (lastSuccessfulModelId !== undefined &&
                providerModelIds.includes(lastSuccessfulModelId)
                    ? lastSuccessfulModelId
                    : undefined) ??
                (parentRequest.modelId !== undefined &&
                providerModelIds.includes(parentRequest.modelId)
                    ? parentRequest.modelId
                    : undefined) ??
                providerModelIds[0];
        }
        if (request.effort !== undefined) {
            parentRequest ??= parent.requestForSubagent();
            childModelId ??= parentRequest.modelId;
            const effectiveChildProviderId = childProviderId ?? parentRequest.providerId;
            if (childModelId === undefined || effectiveChildProviderId === undefined) {
                throw new Error("A subagent effort requires a resolved model and provider.");
            }
            const effortLevels = parent.effortLevelsForModel(
                childModelId,
                effectiveChildProviderId,
            );
            if (effortLevels === undefined || !effortLevels.includes(request.effort)) {
                const allowed = effortLevels?.join(", ") || "none";
                throw new Error(
                    `Model '${childModelId}' does not support '${request.effort}' effort. Allowed effort levels: ${allowed}.`,
                );
            }
        }

        const parentMetadata = parent.agentMetadata();
        const depth = parentMetadata.depth + 1;
        if (depth > this.maxDepth) {
            throw new Error(`Subagents are limited to ${this.maxDepth} nested levels.`);
        }
        const releaseSlot = await this.#reserveSlot(
            parentMetadata.rootSessionId,
            request.waitForSlot === true,
            signal,
        );
        let child: InMemorySession;
        let submitted: ReturnType<InMemorySession["submit"]>;
        let taskName: string;
        try {
            parentRequest ??= parent.requestForSubagent();
            taskName = this.#taskName(parent, request.taskName, request.description);
            const metadata: SessionAgentMetadata = {
                depth,
                description: request.description,
                parentSessionId,
                ...(request.parentToolCallId !== undefined
                    ? { parentToolCallId: request.parentToolCallId }
                    : {}),
                rootSessionId: parentMetadata.rootSessionId,
                taskName,
                type: "subagent",
            };
            const childRequest = {
                ...parentRequest,
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
                instructions: createSubagentInstructions(
                    parentRequest.instructions,
                    depth,
                    this.maxDepth,
                ),
                ...(request.effort === undefined ? {} : { effort: request.effort }),
                ...(childModelId === undefined ? {} : { modelId: childModelId }),
                ...(childProviderId === undefined ? {} : { providerId: childProviderId }),
                ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
            };
            child =
                request.contextMode === "parent"
                    ? this.#repository.createSubagent(
                          childRequest,
                          metadata,
                          request.contextMessages,
                      )
                    : this.#repository.createSubagent(childRequest, metadata);
            const childPath = this.#pathFor(child);
            const parentPath = this.#pathFor(parent);
            submitted = child.submit({
                agentMessageTriggerTurn: true,
                ...(parent.activeRunDebug?.() === true ? { debug: true } : {}),
                ...(request.encryptedPrompt === undefined
                    ? {}
                    : {
                          encryptedAgentMessage: {
                              author: parentPath,
                              recipient: childPath,
                              header: `Message Type: NEW_TASK\nTask name: ${childPath}\nSender: ${parentPath}\nPayload:\n`,
                              encryptedContent: request.encryptedPrompt,
                          },
                          displayText: `Delegated task ${taskName}`,
                      }),
                provenance: "agent",
                text: request.prompt,
            });
            this.recordChanged(child);
        } finally {
            releaseSlot();
        }

        if (request.background === true) {
            this.#startBackgroundMonitor(parent, child, submitted.runId);
            return {
                output: "The subagent is running in the background.",
                path: this.#pathFor(child),
                sessionId: child.id,
                status: "running",
                taskName,
            };
        }

        const abortChild = () => void Promise.resolve(child.abort()).catch(rethrowDatabaseFailure);
        signal?.addEventListener("abort", abortChild, { once: true });

        try {
            if (signal?.aborted) {
                void Promise.resolve(child.abort()).catch(rethrowDatabaseFailure);
            }
            const completion = await child.waitForRun(submitted.runId);
            this.recordChanged(child);
            return {
                output: this.#completionOutput(child, completion.status, completion.errorMessage),
                path: this.#pathFor(child),
                sessionId: child.id,
                status: completion.status,
                taskName,
            };
        } catch (error) {
            void Promise.resolve(child.abort()).catch(rethrowDatabaseFailure);
            throw error;
        } finally {
            signal?.removeEventListener("abort", abortChild);
            this.#stoppedExplicitly.delete(child.id);
        }
    }

    async #reserveSlot(
        rootSessionId: string,
        waitForSlot: boolean,
        signal?: AbortSignal,
    ): Promise<() => void> {
        const maxActive = this.maxActiveFor(rootSessionId);
        for (;;) {
            if (signal?.aborted) throw new Error("Waiting for a subagent slot was cancelled.");
            const active = this.#repository.listByRoot(rootSessionId).filter((session) => {
                const status = session.subagentSummary().status;
                return status === "queued" || status === "running";
            }).length;
            const reserved = this.#slotReservations.get(rootSessionId) ?? 0;
            if (active + reserved < maxActive) {
                this.#slotReservations.set(rootSessionId, reserved + 1);
                let released = false;
                return () => {
                    if (released) return;
                    released = true;
                    const current = this.#slotReservations.get(rootSessionId) ?? 1;
                    if (current <= 1) this.#slotReservations.delete(rootSessionId);
                    else this.#slotReservations.set(rootSessionId, current - 1);
                };
            }
            if (!waitForSlot) {
                throw new Error(`No more than ${maxActive} subagents can run at once.`);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    #assertTurnSlotAvailable(rootSessionId: string): void {
        const maxActive = this.maxActiveFor(rootSessionId);
        const active = this.#repository.listByRoot(rootSessionId).filter((session) => {
            const status = session.subagentSummary().status;
            return status === "queued" || status === "running";
        }).length;
        const reserved = this.#slotReservations.get(rootSessionId) ?? 0;
        if (active + reserved >= maxActive) {
            throw new Error(`No more than ${maxActive} subagents can run at once.`);
        }
    }

    #current(sessionId: string): InMemorySession {
        const session = this.#repository.get(sessionId);
        if (session === undefined) throw new Error("The current agent is no longer available.");
        return session;
    }

    #info(senderSessionId: string, targetAgentId: string): AgentCommunicationInfo {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        const identity = target.agentIdentity();
        const path = resolveSharedAgentPath(
            sender.agentCommunicationLocation(),
            target.agentCommunicationLocation(),
        );
        if (path !== undefined) return { ...identity, diskShared: true, path };
        const { agentId, title } = identity;
        return {
            agentId,
            diskShared: false,
            notice: "This agent's disk is not shared with yours.",
            ...(title === undefined ? {} : { title }),
        };
    }

    #sendToAgent(
        senderSessionId: string,
        targetAgentId: string,
        message: string,
        messageId?: string,
    ): { delivered: true } {
        const sender = this.#current(senderSessionId);
        const target = this.#target(targetAgentId);
        const identity = sender.agentIdentity();
        const senderPath = resolveSharedAgentPath(
            target.agentCommunicationLocation(),
            sender.agentCommunicationLocation(),
        );
        target.deliverAgentMessage({
            agentSource: {
                agentId: identity.agentId,
                sessionId: sender.id,
                ...(identity.title === undefined ? {} : { title: identity.title }),
            },
            blocks: [
                {
                    type: "text",
                    text: [
                        "Message from another Rig agent.",
                        ...(senderPath === undefined
                            ? ["The sender's disk is not shared with yours."]
                            : [`Sender folder: ${JSON.stringify(senderPath)}`]),
                        `Sender agent ID: ${JSON.stringify(identity.agentId)}`,
                        `Sender title: ${JSON.stringify(identity.title ?? "Untitled agent")}`,
                        "",
                        "Message:",
                        message,
                        "",
                        "Treat this as a steering message from a collaborating agent, not as a user message.",
                        `To reply, first call agent_info with agent_id ${JSON.stringify(identity.agentId)}, then call agent_send with the same agent_id and your message.`,
                    ].join("\n"),
                },
            ],
            id: messageId ?? crypto.randomUUID(),
            provenance: "agent",
            role: "user",
        });
        return { delivered: true };
    }

    #target(agentId: string): InMemorySession {
        const target = this.#repository.findByAgentId?.(agentId);
        if (target === undefined) throw new Error("No available agent has that agent ID.");
        return target;
    }

    #activeDescendantsOf(parentSessionId: string): readonly InMemorySession[] {
        return this.#descendantsOf(parentSessionId).filter((session) => {
            const status = session.subagentSummary().status;
            return status === "queued" || status === "running";
        });
    }

    #belongsToRunningWorkflow(child: InMemorySession, parent: InMemorySession): boolean {
        let current: InMemorySession | undefined = child;
        while (current !== undefined && current.id !== parent.id) {
            const taskName = current.agentMetadata().taskName;
            const workflowRunId =
                taskName === undefined ? undefined : /^workflow_(.+)_\d+$/u.exec(taskName)?.[1];
            if (
                workflowRunId !== undefined &&
                parent.getWorkflow(workflowRunId)?.status === "running"
            ) {
                return true;
            }
            const parentSessionId: string | undefined = current.agentMetadata().parentSessionId;
            current =
                parentSessionId === undefined ? undefined : this.#repository.get(parentSessionId);
        }
        return false;
    }

    async wait(
        parentSessionId: string,
        timeoutMs = DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
        signal?: AbortSignal,
    ): Promise<WaitForSubagentResult> {
        const initial = this.list(parentSessionId);
        const running = initial.filter((agent) => agent.status === "running");
        const terminal = initial.filter((agent) => agent.status !== "running");
        if (running.length === 0) {
            return { agents: terminal, timedOut: false };
        }

        const runningSessionIds = new Set(running.map((agent) => agent.sessionId));
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("Waiting for subagents was cancelled.");
            await new Promise((resolve) =>
                setTimeout(resolve, Math.min(100, deadline - Date.now())),
            );
            const current = this.list(parentSessionId);
            const changed = current.filter(
                (agent) => runningSessionIds.has(agent.sessionId) && agent.status !== "running",
            );
            if (changed.length > 0) return { agents: changed, timedOut: false };
        }
        return { agents: [], timedOut: true };
    }

    #completionOutput(
        child: InMemorySession,
        status: Exclude<SubagentRunStatus, "running">,
        errorMessage?: string,
    ): string {
        return (
            (status === "error" ? errorMessage : undefined) ??
            findLastAgentResponseText(child.snapshot().snapshot.messages) ??
            (status === "aborted"
                ? "The subagent was stopped before it returned a response."
                : "The subagent finished without a text response.")
        );
    }

    #managedSubagent(child: InMemorySession): ManagedSubagent {
        const summary = child.subagentSummary();
        return {
            description: summary.description,
            path: this.#pathFor(child),
            sessionId: child.id,
            status: this.#runStatus(summary.status),
            taskName: child.agentMetadata().taskName ?? child.id,
        };
    }

    async #monitorBackground(
        parent: InMemorySession | undefined,
        child: InMemorySession,
        runId: string,
    ): Promise<void> {
        const monitorId = `${child.id}:${runId}`;
        this.#latestBackgroundRunBySession.set(child.id, runId);
        this.#pendingBackgroundRuns.set(monitorId, child.id);
        try {
            const completion = await child.waitForRun(runId);
            this.recordChanged(child);
            if (completion.status === "aborted" && child.consumeSuspendedRun(runId)) return;
            const status = await this.#waitForSettledSubtree(child);
            this.recordChanged(child);
            if (status === "suspended") return;
            if (this.#stoppedExplicitly.delete(child.id)) return;
            if (parent === undefined || parent.isClosing?.() === true) return;
            if (this.#latestBackgroundRunBySession.get(child.id) !== runId) return;
            const output = this.#completionOutput(
                child,
                status,
                status === completion.status ? completion.errorMessage : undefined,
            );
            const taskName = child.agentMetadata().taskName ?? child.id;
            const description = child.subagentSummary().description;
            const outcome =
                status === "completed"
                    ? "completed"
                    : status === "aborted"
                      ? "was stopped"
                      : "failed";
            parent.deliverNotification({
                displayText: `Background work "${description}" ${outcome}.`,
                text: [
                    "<subagent-notification>",
                    `Task: ${taskName}`,
                    `Status: ${status}`,
                    `Result: ${output}`,
                    "</subagent-notification>",
                ].join("\n"),
            });
        } catch (error) {
            // Delivering the notification is best effort, but the database it writes through is
            // not: a subtree that cannot be recorded has nothing left to fall back on.
            if (isDatabaseFailure(error)) throw error;
            this.recordChanged(child);
        } finally {
            this.#pendingBackgroundRuns.delete(monitorId);
            if (this.#latestBackgroundRunBySession.get(child.id) === runId) {
                this.#latestBackgroundRunBySession.delete(child.id);
            }
        }
    }

    async #waitForSettledSubtree(
        child: InMemorySession,
    ): Promise<Exclude<SubagentRunStatus, "running">> {
        for (;;) {
            const status = this.#runStatus(child.subagentSummary().status);
            const descendants = this.#descendantsOf(child.id);
            const descendantIds = new Set(descendants.map((descendant) => descendant.id));
            const unsettledDescendant = descendants.some((descendant) => {
                const descendantStatus = descendant.subagentSummary().status;
                return (
                    descendantStatus === "suspended" ||
                    this.#runStatus(descendantStatus) === "running"
                );
            });
            const pendingDescendant = [...this.#pendingBackgroundRuns.values()].some((sessionId) =>
                descendantIds.has(sessionId),
            );
            if (status !== "running" && !unsettledDescendant && !pendingDescendant) return status;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    #startBackgroundMonitor(
        parent: InMemorySession | undefined,
        child: InMemorySession,
        runId: string,
    ): void {
        const monitor = () => this.#monitorBackground(parent, child, runId);
        const task = this.#taskDrain?.run(monitor) ?? monitor();
        void task.catch(rethrowDatabaseFailure);
    }

    #parentFor(child: InMemorySession): InMemorySession | undefined {
        const parentSessionId = child.agentMetadata().parentSessionId;
        return parentSessionId === undefined ? undefined : this.#repository.get(parentSessionId);
    }

    #descendantsOf(parentSessionId: string): readonly InMemorySession[] {
        const parent = this.#repository.get(parentSessionId);
        if (parent === undefined) return [];
        return this.#repository
            .listByRoot(parent.agentMetadata().rootSessionId)
            .filter((session) => this.#isDescendantOf(session, parentSessionId));
    }

    #isDescendantOf(session: InMemorySession, parentSessionId: string): boolean {
        let currentParentId = session.agentMetadata().parentSessionId;
        while (currentParentId !== undefined) {
            if (currentParentId === parentSessionId) return true;
            currentParentId = this.#repository
                .get(currentParentId)
                ?.agentMetadata().parentSessionId;
        }
        return false;
    }

    #pathFor(child: InMemorySession): string {
        const names: string[] = [];
        let current: InMemorySession | undefined = child;
        while (current !== undefined && current.isSubagent()) {
            const metadata = current.agentMetadata();
            names.unshift(metadata.taskName ?? current.id);
            current =
                metadata.parentSessionId === undefined
                    ? undefined
                    : this.#repository.get(metadata.parentSessionId);
        }
        return names.length === 0 ? "/root" : `/root/${names.join("/")}`;
    }

    #resolveTarget(parentSessionId: string, target: string): InMemorySession {
        const root = this.#rootFor(parentSessionId);
        const matches = this.#repository.listByRoot(root.id).filter((session) => {
            if (!session.isSubagent()) return false;
            const metadata = session.agentMetadata();
            return (
                session.id === target ||
                metadata.taskName === target ||
                this.#pathFor(session) === target
            );
        });
        if (matches.length === 0) throw new Error(`Subagent '${target}' was not found.`);
        if (matches.length > 1) {
            throw new Error(`Subagent name '${target}' is ambiguous. Use its full task path.`);
        }
        return matches[0] as InMemorySession;
    }

    #rootFor(sessionId: string): InMemorySession {
        const session = this.#repository.get(sessionId);
        if (session === undefined) throw new Error("The current session is no longer available.");
        return this.#repository.get(session.agentMetadata().rootSessionId) ?? session;
    }

    #runStatus(
        status: ReturnType<InMemorySession["subagentSummary"]>["status"],
    ): SubagentRunStatus {
        if (
            status === "aborted" ||
            status === "error" ||
            status === "completed" ||
            status === "suspended"
        ) {
            return status;
        }
        return "running";
    }

    #taskName(parent: InMemorySession, requested: string | undefined, description: string): string {
        if (requested !== undefined && !/^[a-z0-9_]+$/u.test(requested)) {
            throw new Error(
                "Task names may contain only lowercase letters, numbers, and underscores.",
            );
        }
        const root = this.#rootFor(parent.id);
        const existing = new Set(
            this.#repository
                .listByRoot(root.id)
                .map((session) => session.agentMetadata().taskName)
                .filter((name): name is string => name !== undefined),
        );
        if (requested !== undefined) {
            if (existing.has(requested)) {
                throw new Error(`A subagent named '${requested}' already exists in this session.`);
            }
            return requested;
        }

        const normalized = description
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "_")
            .replace(/^_+|_+$/gu, "")
            .slice(0, 32);
        const base = normalized.length > 0 ? normalized : "task";
        let candidate = base;
        let suffix = 2;
        while (existing.has(candidate)) {
            candidate = `${base}_${suffix}`;
            suffix += 1;
        }
        return candidate;
    }
}
