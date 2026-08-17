import type {
    AgentCompactionResult,
    AgentSnapshot,
    ContentBlock,
    GoalStatus,
    Model,
    PermissionMode,
    ProviderError,
    SecretAttachmentScope,
    ServiceTier,
    SessionGoal,
    StopReason,
    UserMessage,
} from "../protocol/index.js";
import type { Context } from "@steve.kite/stdlib";
import type {
    AgentRunOptions,
    AgentRunResult,
    CodingAssistantAgentBackend,
    CodingAssistantClientProvider,
    CodingAssistantModelChoice,
    SteeringRunOptions,
} from "../app/CodingAssistantAgentBackend.js";
import type {
    AbortRunOptions,
    ModelCatalog,
    ProtocolSession,
    SessionEvent,
    RunShellCommandResponse,
    ReadBackgroundProcessResponse,
    StopBackgroundProcessResponse,
    SteerMessageResponse,
    SubmitContextMessageResponse,
} from "../protocol/index.js";
import { ProtocolHttpClient } from "./ProtocolHttpClient.js";
import { RemoteAgentRunError } from "./RemoteAgentRunError.js";

export interface RemoteAgentOptions {
    client: ProtocolHttpClient;
    debug?: boolean;
    modelCatalog?: ModelCatalog;
    session: ProtocolSession;
}

/**
 * A model, reasoning effort, fast-mode, or permission choice the user has made here and that no
 * run has carried to the daemon yet.
 *
 * The protocol applies these fields when the next message's run starts, so choosing a model is a
 * local decision rather than a separate session mutation that a busy or restrictive daemon could
 * reject. The choice is re-asserted over any authoritative session that still predates it.
 */
interface RemoteAgentSelection {
    readonly effort?: string;
    readonly modelId?: string;
    readonly permissionMode?: PermissionMode;
    readonly providerId?: string;
    /** Null turns fast mode off; absent leaves it untouched. */
    readonly serviceTier?: ServiceTier | null;
}

export class RemoteAgent implements CodingAssistantAgentBackend {
    readonly id: string;

    #client: ProtocolHttpClient;
    #debug: boolean;
    #modelId: string;
    #modelCatalog: ModelCatalog | undefined;
    #models: readonly Model[];
    #providerId: string;
    #pendingSteeringMessages = new Map<string, { message: UserMessage; runId: string }>();
    #session: ProtocolSession;
    #selection: RemoteAgentSelection | undefined;

    constructor(options: RemoteAgentOptions) {
        this.#client = options.client;
        this.#debug = options.debug === true;
        this.#session = options.session;
        this.#modelCatalog = options.modelCatalog;
        this.id = options.session.agentId;
        this.#modelId = options.session.modelId;
        this.#models = options.session.models;
        this.#providerId = options.session.providerId;
    }

    async steer(
        content: string | readonly ContentBlock[],
        options: SteeringRunOptions = {},
    ): Promise<SteerMessageResponse> {
        const displayText = options.displayText ?? contentToDisplayText(content);
        const selection = this.#selection;
        try {
            const submitted = await this.#client.steerMessage(this.#session.id, {
                ...(options.clientSubmissionId === undefined
                    ? {}
                    : { clientSubmissionId: options.clientSubmissionId }),
                ...(options.expectedRunId === undefined
                    ? {}
                    : { expectedRunId: options.expectedRunId }),
                ...(typeof content === "string" ? {} : { content }),
                ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
                ...this.#messageSelection(selection),
                text: displayText,
            });
            this.#clearSubmittedSelection(selection);
            return submitted;
        } catch (error) {
            if (options.clientSubmissionId !== undefined) {
                try {
                    const { events } = await this.#client.getEvents(this.#session.id);
                    const submitted = events.find(
                        (event) =>
                            event.type === "message_submitted" &&
                            event.data.message.id === options.clientSubmissionId,
                    );
                    if (
                        submitted?.type === "message_submitted" &&
                        submitted.data.delivery !== "context"
                    ) {
                        const reconciled = {
                            delivery: submitted.data.delivery ?? "run",
                            eventId: submitted.id,
                            runId: submitted.data.runId,
                            sessionId: submitted.sessionId,
                        };
                        this.#clearSubmittedSelection(selection);
                        return reconciled;
                    }
                } catch {
                    // Preserve the original steering error when acceptance cannot be reconciled.
                }
            }
            throw error;
        }
    }

    get canChangeModel(): boolean {
        return !this.#session.modelLocked;
    }

    get confirmedServiceTier(): ServiceTier | undefined {
        return sessionServiceTier(this.#session);
    }

    get provider(): CodingAssistantClientProvider {
        const serviceTiers = this.#modelCatalog?.providers.find(
            (provider) => provider.providerId === this.#providerId,
        )?.serviceTiers;
        return {
            id: this.#providerId,
            models: this.#models,
            ...(serviceTiers === undefined ? {} : { serviceTiers }),
        };
    }

    get model(): Model {
        const model = this.#models.find((candidate) => candidate.id === this.#modelId);
        if (model === undefined) {
            throw new Error(`Unknown remote model '${this.#modelId}'.`);
        }
        return model;
    }

    get modelChoices(): readonly CodingAssistantModelChoice[] {
        return (
            this.#modelCatalog?.providers.flatMap((provider) =>
                provider.models.map((model) => ({ model, providerId: provider.providerId })),
            ) ?? this.#models.map((model) => ({ model, providerId: this.#providerId }))
        );
    }

    get permissionMode(): PermissionMode {
        return this.#session.permissionMode;
    }

    get draft(): string {
        return this.#session.draft ?? "";
    }

    get draftUpdatedAt(): number | undefined {
        return this.#session.draftUpdatedAt;
    }

    /**
     * Store the composer draft on the daemon so the other terminals and clients
     * attached to this session show the same unsent message. `updatedAt` is when
     * the user typed it, which decides who wins when two clients disagree.
     */
    async setDraft(
        draft: string,
        options: { origin?: string; updatedAt?: number } = {},
    ): Promise<void> {
        await this.#client.setSessionDraft(this.#session.id, {
            draft: draft.length === 0 ? null : draft,
            ...(options.origin === undefined ? {} : { origin: options.origin }),
            ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
        });
    }

    get goal(): SessionGoal | undefined {
        return this.#session.goal === undefined ? undefined : { ...this.#session.goal };
    }

    get projectSecretIds(): readonly string[] {
        return [...this.#session.projectSecretIds];
    }

    get secretIds(): readonly string[] {
        return [...this.#session.secretIds];
    }

    get sessionSecretIds(): readonly string[] {
        return [...this.#session.sessionSecretIds];
    }

    async attachSecret(secretId: string, scope: SecretAttachmentScope = "session"): Promise<void> {
        const response = await this.#client.attachSecret(this.#session.id, secretId, scope);
        this.#replaceSession(response.session);
    }

    async detachSecret(secretId: string, scope: SecretAttachmentScope = "session"): Promise<void> {
        const response = await this.#client.detachSecret(this.#session.id, secretId, scope);
        this.#replaceSession(response.session);
    }

    abort(options?: AbortRunOptions) {
        return this.#client.abort(this.#session.id, options);
    }

    async stopBackgroundProcesses(): Promise<number> {
        const response = await this.#client.stopBackgroundProcesses(this.#session.id);
        return response.stoppedProcesses;
    }

    readBackgroundProcess(
        sessionId: number,
        options?: { waitMs?: number },
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        return this.#client.readBackgroundProcess(this.#session.id, sessionId, options);
    }

    stopBackgroundProcess(sessionId: number): Promise<StopBackgroundProcessResponse> {
        return this.#client.stopBackgroundProcess(this.#session.id, sessionId);
    }

    getUsage() {
        return this.#client.getSessionUsage(this.#session.id);
    }

    async setGoal(objective: string): Promise<void> {
        const response = await this.#client.setGoal(this.#session.id, { objective });
        this.#replaceSession(response.session);
    }

    async changeGoalStatus(status: GoalStatus): Promise<void> {
        const response = await this.#client.changeGoalStatus(this.#session.id, { status });
        this.#replaceSession(response.session);
    }

    async clearGoal(): Promise<void> {
        const response = await this.#client.clearGoal(this.#session.id);
        this.#replaceSession(response.session);
    }

    async compact(
        _ctx: Context,
        _signal?: AbortSignal,
        _onEvent?: AgentRunOptions["onEvent"],
    ): Promise<AgentCompactionResult> {
        const response = await this.#client.compact(this.#session.id);
        this.#replaceSession(response.session);
        return response.result;
    }

    async reset(): Promise<void> {
        const response = await this.#client.reset(this.#session.id);
        this.#replaceSession(response.session);
    }

    runShellCommand(
        command: string,
        options: { commandId: string },
    ): Promise<RunShellCommandResponse> {
        return this.#client.runShellCommand(this.#session.id, {
            command,
            commandId: options.commandId,
        });
    }

    async rewind(messageId: string): Promise<UserMessage> {
        const response = await this.#client.rewind(this.#session.id, messageId);
        this.#replaceSession(response.session);
        return response.message;
    }

    async send(
        _ctx: Context,
        content: string | readonly ContentBlock[],
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        const displayText = options.displayText ?? contentToDisplayText(content);
        const requestContent =
            typeof content === "string"
                ? options.displayText !== undefined && content !== displayText
                    ? [{ type: "text" as const, text: content }]
                    : undefined
                : content;
        // The local selection travels with the message the protocol applies it to, so a model or
        // reasoning choice never needs a separate session mutation.
        const selection = this.#selection;
        const submitted = await this.#client.submitMessage(this.#session.id, {
            ...(options.clientSubmissionId === undefined
                ? {}
                : { clientSubmissionId: options.clientSubmissionId }),
            ...(requestContent === undefined ? {} : { content: requestContent }),
            ...(this.#debug ? { debug: true } : {}),
            ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
            ...this.#messageSelection(selection),
            text: displayText,
        });
        this.#clearSubmittedSelection(selection);
        const streamController = new AbortController();
        let finished:
            | {
                  agentRunId?: string;
                  errorMessage?: string;
                  messages: AgentSnapshot["messages"];
                  providerError?: ProviderError;
                  providerId?: string;
                  requestedModelId?: string;
                  stopReason: StopReason;
              }
            | undefined;
        let failure: Error | undefined;
        let aborted = false;

        const abort = () => {
            if (aborted) return;
            aborted = true;
            void this.#client
                .abort(this.#session.id, { expectedRunId: submitted.runId })
                .catch(() => undefined);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted === true) abort();

        await this.#client.watchSessionEvents({
            after: submitted.eventId,
            sessionId: this.#session.id,
            signal: streamController.signal,
            onEvent: async (event) => {
                if (!isRunEvent(event, submitted.runId)) {
                    return;
                }

                this.applySessionEvent(event);

                if (event.type === "run_error") {
                    failure = new RemoteAgentRunError(
                        event.data.errorMessage,
                        submitted.debugDirectory,
                    );
                    streamController.abort();
                    return;
                }

                if (event.type === "run_finished") {
                    finished = {
                        ...(event.data.agentRunId !== undefined
                            ? { agentRunId: event.data.agentRunId }
                            : {}),
                        ...(event.data.errorMessage === undefined
                            ? {}
                            : { errorMessage: event.data.errorMessage }),
                        messages: this.#session.snapshot.messages,
                        ...(event.data.providerError === undefined
                            ? {}
                            : { providerError: event.data.providerError }),
                        ...(event.data.providerId === undefined
                            ? {}
                            : { providerId: event.data.providerId }),
                        ...(event.data.requestedModelId === undefined
                            ? {}
                            : { requestedModelId: event.data.requestedModelId }),
                        stopReason: event.data.stopReason,
                    };
                    streamController.abort();
                }
            },
        });

        options.signal?.removeEventListener("abort", abort);

        if (failure !== undefined) {
            throw failure;
        }
        const debug =
            submitted.debugDirectory === undefined
                ? {}
                : { debugDirectory: submitted.debugDirectory };
        const contextMessages =
            this.#session.snapshot.contextMessages ?? this.#session.snapshot.messages;
        if (finished === undefined) {
            const messages = this.#session.snapshot.messages;
            if (aborted) {
                return {
                    ...debug,
                    messages,
                    contextMessages,
                    runId: submitted.runId,
                    stopReason: "aborted",
                };
            }
            return {
                ...debug,
                errorMessage: "The remote run ended without a completion event.",
                messages,
                contextMessages,
                providerError: {
                    type: "unclassified",
                    diagnostics: {
                        attempts: 1,
                        upstreamMessage: "The remote run ended without a completion event.",
                    },
                },
                providerId: this.#providerId,
                requestedModelId: this.#modelId,
                runId: submitted.runId,
                stopReason: "error",
            };
        }

        if (finished.stopReason === "error") {
            return {
                ...debug,
                errorMessage: finished.errorMessage ?? "The model response failed.",
                messages: finished.messages,
                contextMessages,
                providerError: finished.providerError ?? {
                    type: "unclassified",
                    diagnostics: {
                        attempts: 1,
                        upstreamMessage: finished.errorMessage ?? "The model response failed.",
                    },
                },
                providerId: finished.providerId ?? this.#providerId,
                requestedModelId: finished.requestedModelId ?? this.#modelId,
                runId: finished.agentRunId ?? submitted.runId,
                stopReason: "error",
            };
        }
        return {
            ...debug,
            messages: finished.messages,
            contextMessages,
            runId: finished.agentRunId ?? submitted.runId,
            stopReason: finished.stopReason,
        };
    }

    sendContext(text: string): Promise<SubmitContextMessageResponse> {
        return this.#client.submitContextMessage(this.#session.id, { text });
    }

    setEffort(effort: string | undefined): void {
        if (effort === undefined) return;
        this.#selection = { ...this.#selection, effort };
        this.#applySelection();
    }

    setModel(modelId: string, effort: string | undefined, providerId?: string): void {
        const nextProviderId = providerId ?? this.#providerId;
        if (
            !this.canChangeModel &&
            (modelId !== this.#modelId || nextProviderId !== this.#providerId)
        ) {
            this.setEffort(effort);
            return;
        }

        const nextProvider = this.#modelCatalog?.providers.find(
            (provider) => provider.providerId === nextProviderId,
        );
        const nextModels = nextProvider?.models ?? this.#models;
        if (!nextModels.some((model) => model.id === modelId)) {
            throw new Error(`Unknown remote model '${modelId}' for provider '${nextProviderId}'.`);
        }

        const currentServiceTier = sessionServiceTier(this.#session);
        const keepServiceTier =
            currentServiceTier === undefined ||
            nextProvider?.serviceTiers?.includes(currentServiceTier) === true;
        this.#selection = {
            ...this.#selection,
            ...(effort === undefined ? {} : { effort }),
            modelId,
            providerId: nextProviderId,
            ...(keepServiceTier ? {} : { serviceTier: null }),
        };
        this.#applySelection();
    }

    setServiceTier(serviceTier: ServiceTier | undefined): void {
        this.#selection = { ...this.#selection, serviceTier: serviceTier ?? null };
        this.#applySelection();
    }

    setPermissionMode(permissionMode: PermissionMode): Promise<void> {
        this.#selection = { ...this.#selection, permissionMode };
        this.#applySelection();
        return Promise.resolve();
    }

    snapshot(): AgentSnapshot {
        return this.#session.snapshot;
    }

    applySessionEvent(event: SessionEvent): void {
        if (event.sessionId !== this.#session.id) {
            return;
        }

        if (event.type === "session_created") {
            this.#replaceSession({ ...event.data.session, lastEventId: event.id });
            return;
        }

        if (event.type === "session_updated") {
            const current = event.data.session;
            const loaded = this.#session.snapshot;
            const contextMessages =
                event.data.appendedContextMessage === undefined
                    ? loaded.contextMessages
                    : appendUniqueMessage(
                          loaded.contextMessages ?? loaded.messages,
                          event.data.appendedContextMessage,
                      );
            this.#replaceSession({
                ...current,
                lastEventId: event.id,
                snapshot: {
                    ...current.snapshot,
                    messages: loaded.messages,
                    queue: loaded.queue,
                    tools: loaded.tools,
                    ...(contextMessages === undefined ? {} : { contextMessages }),
                    ...(loaded.instructions === undefined
                        ? {}
                        : { instructions: loaded.instructions }),
                    ...(loaded.lastRunId === undefined ? {} : { lastRunId: loaded.lastRunId }),
                    ...(current.systemPrompt === undefined
                        ? {}
                        : { systemPrompt: current.systemPrompt }),
                },
            });
            return;
        }

        this.#session = { ...this.#session, lastEventId: event.id };

        if (event.type === "system_notice") {
            // A system notice is a visible service row with no run lifecycle and no model context.
            // It advances the cursor like any other event, but the snapshot's messages and context
            // are left untouched. Replay boundaries by event ID already keep it from applying twice.
            return;
        }

        if (event.type === "permission_review") {
            // A permission-review annotation decorates a tool row by tool-call id; it has no run of
            // its own and no effect on this snapshot's messages, context, or run bookkeeping. Like a
            // system notice, it only advances the cursor here — the app that renders the transcript
            // is what attaches it to the tool row.
            return;
        }

        if (event.type === "session_activity_changed") {
            this.#session = { ...this.#session, activity: event.data.activity };
            return;
        }

        if (event.type === "session_archived") {
            this.#session = { ...this.#session, archived: event.data.archived };
            return;
        }

        if (event.type === "session_draft_changed") {
            const { draft, updatedAt } = event.data;
            this.#session =
                draft === undefined
                    ? { ...omitDraft(this.#session), draftUpdatedAt: updatedAt }
                    : { ...this.#session, draft, draftUpdatedAt: updatedAt };
            return;
        }

        if (event.type === "session_workspace_archived") {
            this.#pendingSteeringMessages.clear();
            this.#session = {
                ...this.#session,
                archived: true,
                modelLocked: false,
                status: "archived",
            };
            return;
        }

        if (event.type === "message_submitted") {
            if (event.data.delivery === "context") {
                this.#session = {
                    ...this.#session,
                    snapshot: {
                        ...this.#session.snapshot,
                        messages: appendUniqueMessage(
                            this.#session.snapshot.messages,
                            event.data.message,
                        ),
                    },
                };
                return;
            }
            if (event.data.delivery === "steer") {
                this.#pendingSteeringMessages.set(event.data.message.id, {
                    message: event.data.message,
                    runId: event.data.runId,
                });
                this.#session = { ...this.#session, modelLocked: true, status: "running" };
                return;
            }
            this.#session = {
                ...this.#session,
                modelLocked: true,
                status: this.#session.status === "running" ? "running" : "queued",
                snapshot: {
                    ...this.#session.snapshot,
                    messages: appendUniqueMessage(
                        this.#session.snapshot.messages,
                        event.data.message,
                    ),
                },
            };
            return;
        }

        if (event.type === "steering_applied") {
            for (const messageId of event.data.messageIds) {
                const pending = this.#pendingSteeringMessages.get(messageId);
                if (pending === undefined || pending.runId !== event.data.runId) continue;
                this.#session = {
                    ...this.#session,
                    snapshot: {
                        ...this.#session.snapshot,
                        messages: appendUniqueMessage(
                            this.#session.snapshot.messages,
                            pending.message,
                        ),
                    },
                };
                this.#pendingSteeringMessages.delete(messageId);
            }
            return;
        }

        if (event.type === "agent_message") {
            this.#session = {
                ...this.#session,
                snapshot: {
                    ...this.#session.snapshot,
                    messages: appendUniqueMessage(
                        this.#session.snapshot.messages,
                        event.data.message,
                    ),
                },
            };
            return;
        }

        if (event.type === "run_started") {
            this.#session = { ...this.#session, modelLocked: true, status: "running" };
            return;
        }

        if (event.type === "run_error") {
            this.#discardPendingSteeringMessages(event.data.runId);
            this.#session = {
                ...this.#session,
                modelLocked: event.data.modelLocked,
                status: "error",
            };
            return;
        }

        if (event.type === "run_finished") {
            this.#discardPendingSteeringMessages(event.data.runId);
            this.#session = {
                ...this.#session,
                modelLocked: event.data.modelLocked,
                status: event.data.stopReason === "aborted" ? "aborted" : "completed",
            };
            return;
        }

        if (event.type === "session_reset") {
            this.#pendingSteeringMessages.clear();
            this.#session = {
                ...this.#session,
                modelLocked: false,
                status: "idle",
            };
            this.#applyAuthoritativeSnapshot(event.data.snapshot);
            return;
        }

        if (event.type === "session_rewound") {
            this.#pendingSteeringMessages.clear();
            this.#session = {
                ...this.#session,
                modelLocked: false,
                status: "idle",
            };
            this.#applyAuthoritativeSnapshot(event.data.snapshot);
            return;
        }

        if (event.type === "session_configuration_changed") {
            this.#modelId = event.data.modelId;
            this.#providerId = event.data.providerId;
            this.#models =
                this.#modelCatalog?.providers.find(
                    (provider) => provider.providerId === this.#providerId,
                )?.models ?? this.#models;
            const { effort: _effort, serviceTier: _serviceTier, ...session } = this.#session;
            const {
                effort: _snapshotEffort,
                serviceTier: _snapshotServiceTier,
                ...snapshot
            } = this.#session.snapshot;
            this.#session = {
                ...session,
                ...(event.data.effort !== undefined ? { effort: event.data.effort } : {}),
                // Only an actual model change releases the lock; a reasoning or fast mode change
                // leaves whatever the user pinned in place.
                modelLocked: event.data.changed.includes("model")
                    ? false
                    : this.#session.modelLocked,
                modelId: event.data.modelId,
                models: this.#models,
                providerId: event.data.providerId,
            };
            // Configuration events carry only configuration. Keep the already loaded bounded
            // transcript instead of duplicating it into every durable model or effort change.
            this.#applyAuthoritativeSnapshot({
                ...snapshot,
                ...(event.data.effort === undefined ? {} : { effort: event.data.effort }),
                modelId: event.data.modelId,
                providerId: event.data.providerId,
                ...(event.data.serviceTier === null ? {} : { serviceTier: event.data.serviceTier }),
            });
            return;
        }

        if (event.type === "permission_mode_changed") {
            this.#session = {
                ...this.#session,
                permissionMode: event.data.permissionMode,
            };
            return;
        }

        if (event.type === "secrets_changed") {
            this.#session = {
                ...this.#session,
                projectSecretIds: event.data.projectSecretIds,
                secretIds: event.data.secretIds,
                sessionSecretIds: event.data.sessionSecretIds,
            };
            return;
        }

        if (event.type === "goal_changed") {
            if (event.data.goal === null) {
                const { goal: _goal, ...session } = this.#session;
                this.#session = session;
            } else {
                this.#session = { ...this.#session, goal: { ...event.data.goal } };
            }
            return;
        }

        if (event.type === "user_input_requested") {
            this.#session = {
                ...this.#session,
                pendingUserInputs: [
                    ...this.#session.pendingUserInputs.filter(
                        (request) => request.requestId !== event.data.requestId,
                    ),
                    event.data,
                ],
            };
            return;
        }

        if (event.type === "user_input_resolved") {
            this.#session = {
                ...this.#session,
                pendingUserInputs: this.#session.pendingUserInputs.filter(
                    (request) => request.requestId !== event.data.requestId,
                ),
            };
            return;
        }

        if (event.type === "mcp_servers_changed") {
            this.#session = { ...this.#session, mcpServers: event.data.servers };
            return;
        }

        if (event.type === "tasks_changed") {
            this.#session = { ...this.#session, tasks: event.data.tasks };
            return;
        }

        if (event.type === "external_tool_call_requested") {
            this.#session = {
                ...this.#session,
                pendingExternalToolCalls: [
                    ...(this.#session.pendingExternalToolCalls ?? []).filter(
                        (call) => call.id !== event.data.call.id,
                    ),
                    event.data.call,
                ],
            };
            return;
        }

        if (event.type === "external_tool_call_resolved") {
            this.#session = {
                ...this.#session,
                pendingExternalToolCalls: (this.#session.pendingExternalToolCalls ?? []).filter(
                    (call) => call.id !== event.data.call.id,
                ),
            };
            return;
        }
    }

    #replaceSession(session: ProtocolSession): void {
        if (
            session.lastEventId !== undefined &&
            this.#session.lastEventId !== undefined &&
            session.lastEventId < this.#session.lastEventId
        ) {
            return;
        }
        this.#session = session;
        this.#modelId = session.modelId;
        this.#models = session.models;
        this.#providerId = session.providerId;
        this.#applySelection();
    }

    #discardPendingSteeringMessages(runId: string): void {
        for (const [messageId, pending] of this.#pendingSteeringMessages) {
            if (pending.runId === runId) this.#pendingSteeringMessages.delete(messageId);
        }
    }

    /**
     * The complete selection this message runs on: whatever the person has just changed, over what
     * the session already runs on. The agent infers nothing from the last message, so every message
     * carries the whole answer.
     */
    #messageSelection(selection: RemoteAgentSelection | undefined): {
        readonly effort: string;
        readonly modelId: string;
        readonly permissionMode?: PermissionMode;
        readonly providerId: string;
        readonly serviceTier: ServiceTier | null;
    } {
        const modelId = selection?.modelId ?? this.#session.modelId;
        const providerId = selection?.providerId ?? this.#session.providerId;
        const provider = this.#modelCatalog?.providers.find(
            (candidate) => candidate.providerId === providerId,
        );
        const model = (provider?.models ?? this.#models).find(
            (candidate) => candidate.id === modelId,
        );
        return {
            effort:
                selection?.effort ??
                this.#session.effort ??
                model?.defaultThinkingLevel ??
                "medium",
            modelId,
            ...(selection?.permissionMode === undefined
                ? {}
                : { permissionMode: selection.permissionMode }),
            providerId,
            serviceTier:
                selection?.serviceTier === undefined
                    ? (sessionServiceTier(this.#session) ?? null)
                    : selection.serviceTier,
        };
    }

    #clearSubmittedSelection(selection: RemoteAgentSelection | undefined): void {
        if (selection !== undefined && this.#selection === selection) this.#selection = undefined;
    }

    #applyAuthoritativeSnapshot(snapshot: AgentSnapshot): void {
        const { serviceTier: _serviceTier, ...session } = this.#session;
        this.#session = {
            ...session,
            ...(snapshot.serviceTier === undefined ? {} : { serviceTier: snapshot.serviceTier }),
            snapshot,
        };
        this.#applySelection();
    }

    /**
     * Writes the pending local selection over the current session.
     *
     * It runs both when the user chooses and whenever the daemon sends an authoritative session,
     * because until a run has carried the selection the daemon still describes the previous one.
     */
    #applySelection(): void {
        const selection = this.#selection;
        if (selection === undefined) return;
        if (selection.modelId !== undefined) {
            const providerId = selection.providerId ?? this.#providerId;
            const models =
                this.#modelCatalog?.providers.find((provider) => provider.providerId === providerId)
                    ?.models ?? this.#models;
            this.#modelId = selection.modelId;
            this.#models = models;
            this.#providerId = providerId;
            this.#session = {
                ...this.#session,
                modelId: selection.modelId,
                models,
                providerId,
                snapshot: {
                    ...this.#session.snapshot,
                    modelId: selection.modelId,
                    providerId,
                },
            };
        }
        if (selection.effort !== undefined) {
            this.#session = {
                ...this.#session,
                effort: selection.effort,
                snapshot: { ...this.#session.snapshot, effort: selection.effort },
            };
        }
        if (selection.serviceTier !== undefined) {
            this.#setLocalServiceTier(selection.serviceTier ?? undefined);
        }
        if (selection.permissionMode !== undefined) {
            this.#session = {
                ...this.#session,
                permissionMode: selection.permissionMode,
            };
        }
    }

    #setLocalServiceTier(serviceTier: ServiceTier | undefined): void {
        const { serviceTier: _sessionServiceTier, ...session } = this.#session;
        const { serviceTier: _snapshotServiceTier, ...snapshot } = this.#session.snapshot;
        this.#session = {
            ...session,
            ...(serviceTier === undefined ? {} : { serviceTier }),
            snapshot: {
                ...snapshot,
                ...(serviceTier === undefined ? {} : { serviceTier }),
            },
        };
    }
}

function omitDraft(session: ProtocolSession): ProtocolSession {
    const { draft: _draft, ...rest } = session;
    return rest;
}

function sessionServiceTier(session: ProtocolSession): ServiceTier | undefined {
    return session.serviceTier ?? session.snapshot.serviceTier;
}

function appendUniqueMessage(
    messages: AgentSnapshot["messages"],
    message: AgentSnapshot["messages"][number],
): AgentSnapshot["messages"] {
    if (messages.some((candidate) => candidate.id === message.id)) {
        return messages;
    }
    return [...messages, message];
}

function isRunEvent(event: SessionEvent, runId: string): boolean {
    if (event.type === "session_activity_changed") {
        return event.data.activity.runId === runId;
    }
    if (
        event.type !== "agent_event" &&
        event.type !== "provider_event" &&
        event.type !== "agent_message" &&
        event.type !== "run_error" &&
        event.type !== "run_finished" &&
        event.type !== "run_started" &&
        event.type !== "steering_applied"
    ) {
        return false;
    }

    return event.data.runId === runId;
}

function contentToDisplayText(content: string | readonly ContentBlock[]): string {
    if (typeof content === "string") {
        return content;
    }

    return content
        .map((block) => (block.type === "text" ? block.text : `[image:${block.mediaType}]`))
        .join("");
}
