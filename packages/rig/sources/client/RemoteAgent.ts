import type { Context } from "@steve.kite/stdlib";
import type {
    Agent as ApiAgent,
    DaemonConfig,
    HappyAgentClient,
    HappyAgentEvent,
    Message as ApiMessage,
    MessageBlock as ApiMessageBlock,
    MessageHistoryResponse,
    MessageMode,
    Run,
    ToolCallBlock as ApiToolCallBlock,
} from "@slopus/happy-agent-client";

import type {
    AgentCompactionResult,
    AgentLoopEvent,
    AgentSnapshot,
    ContentBlock,
    Message,
    Model,
    PermissionMode,
    ServiceTier,
    StopReason,
    ToolCallBlock,
    ToolResultBlock,
} from "../protocol/index.js";
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
    AbortRunResponse,
    GetSessionUsageResponse,
    ReadBackgroundProcessResponse,
    RunShellCommandResponse,
    SteerMessageResponse,
    StopBackgroundProcessResponse,
} from "../protocol/index.js";
import { RemoteAgentRunError } from "./RemoteAgentRunError.js";
import type { HappyAgentEventHub } from "./HappyAgentEventHub.js";

export interface RemoteAgentOptions {
    agent: ApiAgent;
    client: HappyAgentClient;
    config: DaemonConfig;
    events: HappyAgentEventHub;
    history: MessageHistoryResponse;
}

interface PendingSelection {
    effort?: string;
    modelId?: string;
    permissionMode?: PermissionMode;
    providerId?: string;
    serviceTier?: ServiceTier | null;
}

/**
 * The TUI's agent backend over the public Happy Agent API.
 *
 * This class projects public message blocks into Rig's renderer vocabulary, but
 * it never reconstructs or calls the removed session protocol. Runs, messages,
 * steering, compaction, drafts, questions, and processes all go through the
 * durable `HappyAgentClient` instance supplied by the daemon connection.
 */
export class RemoteAgent implements CodingAssistantAgentBackend {
    readonly id: string;

    #agent: ApiAgent;
    readonly #client: HappyAgentClient;
    readonly #config: DaemonConfig;
    readonly #events: HappyAgentEventHub;
    #history: MessageHistoryResponse;
    readonly #messages = new Map<string, ApiMessage>();
    readonly #messageEventResults = new Map<string, ApiMessage | typeof MESSAGE_DELETED>();
    #activeSend = false;
    #resyncing: Promise<AgentSnapshot> | undefined;
    #selection: PendingSelection | undefined;

    constructor(options: RemoteAgentOptions) {
        this.#agent = options.agent;
        this.#client = options.client;
        this.#config = options.config;
        this.#events = options.events;
        this.#history = options.history;
        this.id = options.agent.id;
        for (const run of options.history.runs) {
            for (const message of run.messages) this.#messages.set(message.id, message);
        }
        for (const message of options.history.pending) this.#messages.set(message.id, message);
    }

    get canChangeModel(): boolean {
        return true;
    }

    get confirmedServiceTier(): ServiceTier | undefined {
        return this.#currentMode().serviceTier === null ? undefined : "fast";
    }

    get provider(): CodingAssistantClientProvider {
        const providerId = this.#currentMode().providerId;
        const provider = this.#config.providers[providerId];
        return {
            id: providerId,
            models: this.#modelsForProvider(providerId),
            ...(provider?.models.some(
                (reference) =>
                    reference.enabled &&
                    (
                        reference.serviceTiers ??
                        this.#config.models[reference.id]?.serviceTiers ??
                        []
                    ).length > 0,
            )
                ? { serviceTiers: ["fast" as const] }
                : {}),
        };
    }

    get model(): Model {
        const mode = this.#currentMode();
        const model = this.#modelsForProvider(mode.providerId).find(
            (candidate) => candidate.id === mode.modelId,
        );
        if (model === undefined) {
            throw new Error(`Unknown model '${mode.modelId}' for provider '${mode.providerId}'.`);
        }
        return model;
    }

    get modelChoices(): readonly CodingAssistantModelChoice[] {
        return Object.entries(this.#config.providers).flatMap(([providerId, provider]) =>
            provider.enabled
                ? this.#modelsForProvider(providerId).map((model) => ({ model, providerId }))
                : [],
        );
    }

    get permissionMode(): PermissionMode {
        return this.#currentMode().permissionMode;
    }

    get draft(): string {
        return this.#agent.draft?.text ?? "";
    }

    get draftUpdatedAt(): number | undefined {
        return this.#agent.draft === null ? undefined : this.#agent.updatedAt;
    }

    async setDraft(
        draft: string,
        options: { origin?: string; updatedAt?: number } = {},
    ): Promise<void> {
        const mode = this.#currentMode();
        const response = await this.#client.saveAgentDraft(this.id, {
            draft:
                draft.length === 0
                    ? null
                    : {
                          effort: mode.effort,
                          modelId: mode.modelId,
                          permissionMode: mode.permissionMode,
                          providerId: mode.providerId,
                          serviceTier: mode.serviceTier,
                          text: draft,
                      },
            ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
            ...(options.origin === undefined ? {} : { mutationId: options.origin }),
        });
        this.#agent = response.agent;
    }

    async abort(options: AbortRunOptions = {}): Promise<AbortRunResponse> {
        const response = await this.#client.abortAgent(this.id, {
            ...(options.expectedRunId === undefined
                ? {}
                : { expectedRunId: options.expectedRunId }),
            ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
        });
        this.#agent = response.agent;
        return { aborted: true, eventId: response.cursor };
    }

    async stopBackgroundProcesses(): Promise<number> {
        const activity = await this.#client.getAgentActivity(this.id);
        const running = activity.processes.filter((process) => process.status === "running");
        await Promise.all(running.map((process) => this.#client.stopProcess(this.id, process.id)));
        return running.length;
    }

    readBackgroundProcess(
        _sessionId: number,
        _options?: { waitMs?: number },
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        // The public process API deliberately exposes lifecycle, not output.
        return Promise.resolve(undefined);
    }

    stopBackgroundProcess(_sessionId: number): Promise<StopBackgroundProcessResponse> {
        // Public process IDs are CUID2 strings; the old numeric terminal handle
        // is not fabricated or guessed.
        return Promise.resolve({ stopped: false });
    }

    async getUsage(): Promise<GetSessionUsageResponse> {
        const response = await this.#client.getAgentUsage(this.id);
        const groups = Object.entries(response.usage).flatMap(([providerId, models]) =>
            Object.entries(models).map(([modelId, usage]) => ({
                kind: "attributed" as const,
                modelId,
                providerId,
                requestedModelId: modelId,
                usage: {
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                        total: 0,
                    },
                    input: usage.input,
                    output: usage.output,
                    totalTokens: usage.input + usage.output,
                },
            })),
        );
        return {
            currentProviderId: this.#currentMode().providerId,
            groups,
            quotas: [],
            sessionTokenCount: {
                lastContextTokens: 0,
                totalTokens: groups.reduce((total, group) => total + group.usage.totalTokens, 0),
            },
        };
    }

    async compact(
        _ctx: Context,
        _signal?: AbortSignal,
        _onEvent?: AgentRunOptions["onEvent"],
    ): Promise<AgentCompactionResult> {
        const response = await this.#client.compactAgent(this.id);
        this.#agent = response.agent;
        return {
            compacted: true,
            compactedMessageCount: 0,
            estimatedTokensAfter: 0,
            estimatedTokensBefore: 0,
            retainedMessageCount: this.#snapshotMessages().length,
        };
    }

    reset(): Promise<void> {
        return Promise.reject(
            new Error("The Happy Agent API does not expose transcript reset or rewind."),
        );
    }

    runShellCommand(
        _command: string,
        _options: { commandId: string },
    ): Promise<RunShellCommandResponse> {
        return Promise.reject(
            new Error(
                "Direct shell composer commands are not part of the Happy Agent API. Send the command to the agent instead.",
            ),
        );
    }

    async steer(
        content: string | readonly ContentBlock[],
        options: SteeringRunOptions = {},
    ): Promise<void | SteerMessageResponse> {
        const selection = this.#selection;
        await this.#client.sendMessage(this.id, {
            ...toSendBody(content, options.displayText, this.#messageMode(selection)),
            delivery: "steer",
            ...(options.clientSubmissionId === undefined ? {} : { id: options.clientSubmissionId }),
        });
        this.#clearSelection(selection);
    }

    async send(
        _ctx: Context,
        content: string | readonly ContentBlock[],
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        const selection = this.#selection;
        this.#activeSend = true;
        const submitted = await this.#client
            .sendMessage(this.id, {
                ...toSendBody(content, options.displayText, this.#messageMode(selection)),
                delivery: "queue",
                ...(options.clientSubmissionId === undefined
                    ? {}
                    : { id: options.clientSubmissionId }),
            })
            .catch((error: unknown) => {
                this.#activeSend = false;
                throw error;
            });
        this.#clearSelection(selection);

        let activeRunId = submitted.message.runId;
        let terminalRun: Run | undefined;
        let aborted = false;
        const streamController = new AbortController();
        const abort = () => {
            aborted = true;
            void this.#client
                .abortAgent(this.id, activeRunId === null ? {} : { expectedRunId: activeRunId })
                .catch(() => undefined);
            streamController.abort();
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted === true) abort();

        try {
            await this.#events.follow({
                after: submitted.cursor,
                signal: streamController.signal,
                onGap: async () => {
                    await this.resync();
                    const recovered = this.#history.runs.find((run) =>
                        run.messages.some((message) => message.id === submitted.message.id),
                    );
                    if (recovered === undefined) return;
                    activeRunId = recovered.id;
                    if (recovered.status !== "running") {
                        terminalRun = recovered;
                        streamController.abort();
                    }
                },
                onEvent: async (event) => {
                    if (!belongsToAgent(event, this.id)) return false;
                    this.#applyResourceEvent(event);
                    await this.#forwardMessageEvent(event, options);

                    if (
                        event.type === "run.started" &&
                        event.payload.acceptedMessageIds.includes(submitted.message.id)
                    ) {
                        activeRunId = event.payload.run.id;
                    } else if (
                        event.type === "run.boundary" &&
                        activeRunId === event.payload.finishedRun.id
                    ) {
                        // Steering is one user-visible continuation. Keep consuming
                        // the atomic successor instead of leaving its output without
                        // an owner in the terminal.
                        activeRunId = event.payload.startedRun.id;
                    } else if (
                        event.type === "run.finished" &&
                        activeRunId === event.payload.run.id
                    ) {
                        terminalRun = event.payload.run;
                        return true;
                    }
                    return false;
                },
            });
        } catch (error) {
            if (!aborted) throw error;
        } finally {
            this.#activeSend = false;
            options.signal?.removeEventListener("abort", abort);
            streamController.abort();
        }

        await this.#refresh();
        const snapshot = this.snapshot();
        const runId = terminalRun?.id ?? activeRunId ?? submitted.message.id;
        const stopReason = aborted ? "aborted" : toStopReason(terminalRun);
        if (terminalRun?.status === "failed") {
            throw new RemoteAgentRunError(
                failedRunMessage(this.#history, terminalRun.id) ?? "The remote run failed.",
            );
        }
        return {
            contextMessages: snapshot.messages,
            messages: snapshot.messages,
            runId,
            stopReason,
        };
    }

    setEffort(effort: string | undefined): void {
        if (effort === undefined) return;
        this.#selection = { ...this.#selection, effort };
    }

    setModel(modelId: string, effort: string | undefined, providerId?: string): void {
        const resolvedProviderId = providerId ?? this.#currentMode().providerId;
        if (!this.#modelsForProvider(resolvedProviderId).some((model) => model.id === modelId)) {
            throw new Error(`Unknown model '${modelId}' for provider '${resolvedProviderId}'.`);
        }
        this.#selection = {
            ...this.#selection,
            ...(effort === undefined ? {} : { effort }),
            modelId,
            providerId: resolvedProviderId,
        };
    }

    setServiceTier(serviceTier: ServiceTier | undefined): void {
        this.#selection = { ...this.#selection, serviceTier: serviceTier ?? null };
    }

    setPermissionMode(permissionMode: PermissionMode): Promise<void> {
        this.#selection = { ...this.#selection, permissionMode };
        return Promise.resolve();
    }

    snapshot(): AgentSnapshot {
        const mode = this.#currentMode();
        return {
            effort: mode.effort,
            id: this.id,
            messages: this.#snapshotMessages(),
            modelId: mode.modelId,
            providerId: mode.providerId,
            queue: this.#history.pending.map((message) => ({
                id: message.id,
                message: toRigMessage(message),
            })),
            ...(mode.serviceTier === null ? {} : { serviceTier: "fast" }),
            status: this.#agent.status === "idle" ? "idle" : "running",
            tools: [],
        };
    }

    /** Reloads the authoritative agent and transcript after an event-stream gap. */
    async resync(): Promise<AgentSnapshot> {
        if (this.#resyncing !== undefined) return await this.#resyncing;
        const resyncing = this.#refresh().then(() => this.snapshot());
        this.#resyncing = resyncing;
        try {
            return await resyncing;
        } finally {
            if (this.#resyncing === resyncing) this.#resyncing = undefined;
        }
    }

    /** Applies one global API event and returns a renderable message when it carried one. */
    applyEvent(event: HappyAgentEvent): Message | undefined {
        if (!belongsToAgent(event, this.id)) return undefined;
        this.#applyResourceEvent(event);
        const message = this.#projectMessageEvent(event);
        if (message !== undefined && message !== MESSAGE_DELETED && event.type !== "message.delta")
            return toRigMessage(message);
        return undefined;
    }

    /** Projects streaming and reset API events into Rig's live inference vocabulary. */
    applyLoopEvent(event: HappyAgentEvent): AgentLoopEvent | undefined {
        if (this.#activeSend) return undefined;
        return this.#projectLoopEvent(event);
    }

    #projectLoopEvent(event: HappyAgentEvent): AgentLoopEvent | undefined {
        if (!belongsToAgent(event, this.id)) return undefined;
        const message = this.#projectMessageEvent(event);
        if (event.type === "message.deleted") return { type: "block_reset" };
        if (
            event.type !== "message.delta" ||
            message === undefined ||
            message === MESSAGE_DELETED
        ) {
            return undefined;
        }
        const block = message.content[event.payload.blockIndex];
        if (block?.type === "reasoning") {
            return {
                type: "thinking_delta",
                contentIndex: event.payload.blockIndex,
                delta: event.payload.append,
            };
        }
        if (block?.type === "text") {
            return { type: "text_delta", delta: event.payload.append };
        }
        return undefined;
    }

    #modelsForProvider(providerId: string): readonly Model[] {
        const provider = this.#config.providers[providerId];
        if (provider === undefined) return [];
        return provider.models.flatMap((reference) => {
            const definition = this.#config.models[reference.id];
            if (!reference.enabled || definition === undefined) return [];
            return [
                {
                    defaultThinkingLevel: definition.defaultEffort,
                    id: reference.id,
                    name: definition.name,
                    thinkingLevels: definition.efforts,
                },
            ];
        });
    }

    #currentMode(): MessageMode {
        const base = this.#agent.lastMode ?? this.#config.defaults;
        const previousServiceTier = this.#agent.lastMode?.serviceTier ?? null;
        return {
            effort: this.#selection?.effort ?? base.effort,
            modelId: this.#selection?.modelId ?? base.modelId,
            permissionMode: this.#selection?.permissionMode ?? base.permissionMode,
            providerId: this.#selection?.providerId ?? base.providerId,
            serviceTier:
                this.#selection?.serviceTier === undefined
                    ? previousServiceTier
                    : this.#selection.serviceTier === null
                      ? null
                      : preferredServiceTier(
                            this.#config,
                            this.#selection?.providerId ?? base.providerId,
                            this.#selection?.modelId ?? base.modelId,
                        ),
        };
    }

    #messageMode(selection: PendingSelection | undefined): MessageMode {
        const current = this.#currentMode();
        if (selection === undefined) return current;
        return {
            effort: selection.effort ?? current.effort,
            modelId: selection.modelId ?? current.modelId,
            permissionMode: selection.permissionMode ?? current.permissionMode,
            providerId: selection.providerId ?? current.providerId,
            serviceTier:
                selection.serviceTier === undefined
                    ? current.serviceTier
                    : selection.serviceTier === null
                      ? null
                      : preferredServiceTier(
                            this.#config,
                            selection.providerId ?? current.providerId,
                            selection.modelId ?? current.modelId,
                        ),
        };
    }

    #clearSelection(selection: PendingSelection | undefined): void {
        if (selection !== undefined && this.#selection === selection) this.#selection = undefined;
    }

    #snapshotMessages(): Message[] {
        return this.#history.runs.flatMap((run) => run.messages.map(toRigMessage));
    }

    async #refresh(): Promise<void> {
        const [agent, history] = await Promise.all([
            this.#client.getAgent(this.id),
            this.#client.getMessages(this.id, { limit: 50 }),
        ]);
        this.#agent = agent.agent;
        this.#history = history;
        this.#messages.clear();
        for (const run of history.runs) {
            for (const message of run.messages) this.#messages.set(message.id, message);
        }
        for (const message of history.pending) this.#messages.set(message.id, message);
    }

    #applyResourceEvent(event: HappyAgentEvent): void {
        if (event.type !== "agent.updated" || event.payload.agentId !== this.id) return;
        this.#agent = {
            ...this.#agent,
            ...event.payload.changes,
            version: event.payload.version,
        };
    }

    async #forwardMessageEvent(event: HappyAgentEvent, options: AgentRunOptions): Promise<void> {
        const message = this.applyEvent(event);
        const loopEvent = this.#projectLoopEvent(event);
        if (loopEvent !== undefined) await options.onEvent?.(loopEvent);
        if (message?.role === "agent" || message?.role === "error") {
            await options.onMessage?.(message);
        }
    }

    #projectMessageEvent(event: HappyAgentEvent): ApiMessage | typeof MESSAGE_DELETED | undefined {
        const cached = this.#messageEventResults.get(event.cursor);
        if (cached !== undefined) return cached;
        let result: ApiMessage | typeof MESSAGE_DELETED | undefined;
        if (event.type === "message.created" || event.type === "message.updated") {
            result = structuredClone(event.payload.message);
            this.#messages.set(result.id, result);
        } else if (event.type === "message.delta") {
            const current = this.#messages.get(event.payload.messageId);
            const block = current?.content[event.payload.blockIndex];
            if (current !== undefined && (block?.type === "text" || block?.type === "reasoning")) {
                result = {
                    ...current,
                    content: current.content.map((candidate, index) =>
                        index === event.payload.blockIndex
                            ? { ...block, text: block.text + event.payload.append }
                            : candidate,
                    ),
                };
                this.#messages.set(result.id, result);
            }
        } else if (event.type === "message.deleted") {
            this.#messages.delete(event.payload.messageId);
            result = MESSAGE_DELETED;
        }
        if (result !== undefined) {
            this.#messageEventResults.set(event.cursor, result);
            if (this.#messageEventResults.size > 512) {
                const oldest = this.#messageEventResults.keys().next().value as string | undefined;
                if (oldest !== undefined) this.#messageEventResults.delete(oldest);
            }
        }
        return result;
    }
}

const MESSAGE_DELETED = Symbol("message-deleted");

function toSendBody(
    content: string | readonly ContentBlock[],
    displayText: string | undefined,
    mode: MessageMode,
): {
    content?: ApiMessageBlock[];
    mode: MessageMode;
    text: string;
} {
    if (typeof content === "string") {
        return { mode, text: displayText ?? content };
    }
    return {
        content: content.map((block) =>
            block.type === "text"
                ? { text: block.text, type: "text" as const }
                : {
                      data: block.data,
                      mimeType: block.mediaType,
                      type: "image" as const,
                  },
        ),
        mode,
        text:
            displayText ??
            content
                .map((block) => (block.type === "text" ? block.text : `[image:${block.mediaType}]`))
                .join(""),
    };
}

function toRigMessage(message: ApiMessage): Message {
    if (message.role === "user") {
        return {
            blocks: message.content.flatMap(toRigContentBlock),
            id: message.id,
            role: "user",
        };
    }
    if (message.role === "agent") {
        return {
            blocks: message.content.flatMap((block, index) =>
                toRigAgentBlocks(message.id, block, index),
            ),
            id: message.id,
            role: "agent",
        };
    }
    if (message.role === "service") {
        return {
            blocks: message.content.flatMap(toRigContentBlock),
            id: message.id,
            outcome: "failed",
            role: "error",
        };
    }
    return {
        blocks: message.content.flatMap(toRigContentBlock),
        id: message.id,
        role: "system",
    };
}

function toRigContentBlock(block: ApiMessageBlock): ContentBlock[] {
    if (block.type === "text") return [{ text: block.text, type: "text" }];
    if (block.type === "image") {
        return [{ data: block.data, mediaType: block.mimeType, type: "image" }];
    }
    if (block.type === "reasoning") return [{ text: block.text, type: "text" }];
    return [];
}

function toRigAgentBlocks(
    messageId: string,
    block: ApiMessageBlock,
    index: number,
): (ContentBlock | { thinking: string; type: "thinking" } | ToolCallBlock | ToolResultBlock)[] {
    if (block.type === "text") return [{ text: block.text, type: "text" }];
    if (block.type === "image") {
        return [{ data: block.data, mediaType: block.mimeType, type: "image" }];
    }
    if (block.type === "reasoning") return [{ thinking: block.text, type: "thinking" }];
    const toolCallId = `${messageId}:tool:${String(index)}`;
    const callPresentation = toToolCallPresentation(block);
    const call: ToolCallBlock = {
        arguments: block.arguments ?? {},
        id: toolCallId,
        name: block.name,
        ...(callPresentation === undefined ? {} : { presentation: callPresentation }),
        type: "tool_call",
    };
    if (block.status === "running") return [call];
    const resultPresentation = toToolResultPresentation(block);
    const result: ToolResultBlock = {
        display: toolResultText(block),
        ...(block.status === "failed"
            ? { failure: { kind: "execution_failed" as const }, isError: true }
            : {}),
        ...(resultPresentation === undefined ? {} : { presentation: resultPresentation }),
        rendered: [],
        toolCallId,
        toolName: block.name,
        type: "tool_result",
    };
    return [call, result];
}

function toToolCallPresentation(
    block: ApiToolCallBlock,
): ToolCallBlock["presentation"] | undefined {
    const presentation = block.presentation;
    if (presentation?.type === "exploration") {
        return { operations: presentation.operations, type: "exploration" };
    }
    if (presentation?.type === "exec_command") {
        return { command: presentation.command, type: "exec_command" };
    }
    if (presentation?.type === "search") {
        return { query: presentation.query, target: presentation.target, type: "search" };
    }
    return undefined;
}

function toToolResultPresentation(
    block: ApiToolCallBlock,
): ToolResultBlock["presentation"] | undefined {
    const presentation = block.presentation;
    if (presentation?.type === "exploration") {
        return { operations: presentation.operations, type: "exploration" };
    }
    if (presentation?.type === "exec_command") {
        return {
            command: presentation.command,
            output: presentation.output ?? toolResultText(block),
            type: "exec_command",
        };
    }
    if (presentation?.type === "background_terminal_interaction") {
        // Rig's old renderer used numeric process handles. Do not invent one
        // from the public CUID2; render the command as an ordinary result.
        return {
            command: presentation.command,
            output: presentation.input,
            type: "exec_command",
        };
    }
    if (presentation?.type === "file_diff") {
        return {
            files: presentation.files,
            ...(presentation.omittedFiles === undefined
                ? {}
                : { omittedFiles: presentation.omittedFiles }),
            type: "file_diff",
        };
    }
    if (presentation?.type === "search") {
        return {
            query: presentation.query,
            sources: presentation.sources ?? [],
            target: presentation.target,
            type: "search",
        };
    }
    return undefined;
}

function toolResultText(block: ApiToolCallBlock): string {
    const output = block.result?.output;
    if (typeof output === "string") return output;
    if (block.result === undefined) return block.status === "failed" ? "Tool failed." : "";
    return JSON.stringify(block.result);
}

function belongsToAgent(event: HappyAgentEvent, agentId: string): boolean {
    const payload = event.payload as { agentId?: unknown; agent?: { id?: unknown } };
    return payload.agentId === agentId || payload.agent?.id === agentId;
}

function failedRunMessage(history: MessageHistoryResponse, runId: string): string | undefined {
    const run = history.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return undefined;
    for (const message of run.messages.toReversed()) {
        if (message.role !== "service") continue;
        const text = message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();
        if (text.length > 0) return text;
    }
    return undefined;
}

function toStopReason(run: Run | undefined): StopReason {
    if (run === undefined) return "error";
    if (run.reason === "abort" || run.reason === "steering") return "aborted";
    if (run.reason === "error" || run.status === "failed") return "error";
    return "stop";
}

function preferredServiceTier(
    config: DaemonConfig,
    providerId: string,
    modelId: string,
): string | null {
    const reference = config.providers[providerId]?.models.find((model) => model.id === modelId);
    return (reference?.serviceTiers ?? config.models[modelId]?.serviceTiers ?? [])[0] ?? null;
}
