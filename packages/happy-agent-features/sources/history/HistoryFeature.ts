import type {
    AgentBaseInference,
    AgentBaseToolExecution,
    AgentFeature,
    AgentFeatureScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { HistoryBlock, HistoryMessage } from "./HistoryMessage.js";
import type { HistoryPage, HistoryQuery } from "./HistoryPage.js";
import type { HistoryRecord, HistoryStore } from "./HistoryStore.js";
import { selectHistoryPage } from "./impl/selectHistoryPage.js";
import { readAgentHistoryTool } from "./tools/read_agent_history.js";

/** What a history feature is built with. */
export interface HistoryFeatureOptions {
    /** Where history is kept. The host owns it: a database, an archive, a transcript. */
    readonly store: HistoryStore;
    /** How much of one tool's output is worth keeping. Defaults to 16,000 characters. */
    readonly toolOutputLimit?: number;
}

/** How much tool output is recorded before the rest is dropped as not worth keeping. */
const DEFAULT_TOOL_OUTPUT_LIMIT = 16_000;

/**
 * The agent's own record of what happened, which it can read back.
 *
 * This is not the model's context. The context is what the provider is replaying right now, and
 * it is compacted, reset, and thrown away as the conversation moves; the history is what was
 * said and done, kept whether or not any model can still see it. The two are deliberately
 * separate: a conversation reset by an incompatible model switch loses its context entirely and
 * loses none of its history.
 *
 * The feature writes as the agent works — every completed assistant response, every tool result,
 * every failed inference — and never lets that writing decide anything: a store that is slow or
 * broken loses the record, not the run. What it cannot see, it is told: a user message belongs to
 * whoever sent it, so the host records those with `record`.
 *
 * Reading is the `read_agent_history` tool for the model, and `read` for everyone else, both
 * over the same paging, searching, and bounding.
 */
export class HistoryFeature implements AgentFeature {
    readonly name = "history";

    /** Where the history is kept. */
    readonly #store: HistoryStore;
    /** How much of a tool's output is worth recording. */
    readonly #toolOutputLimit: number;
    /** What the response in progress has produced so far, per agent. */
    readonly #pending = new Map<string, PendingResponse>();

    constructor(options: HistoryFeatureOptions) {
        this.#store = options.store;
        this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    }

    /** Add a message to an agent's history. This is how a host records what it sent. */
    async record(ctx: Context, agentId: string, message: HistoryMessage): Promise<void> {
        await this.#store.append(ctx, agentId, [
            { at: Date.now(), ...message } satisfies HistoryMessage,
        ]);
    }

    /** Everything an agent's history holds, oldest first. */
    async messages(ctx: Context, agentId: string): Promise<readonly HistoryRecord[]> {
        return await this.#store.read(ctx, agentId);
    }

    /**
     * One page of an agent's history, filtered and paged the same way for every reader. The
     * page carries the messages themselves; rendering them within a size is `formatHistoryPage`.
     */
    async read(ctx: Context, agentId: string, query: HistoryQuery = {}): Promise<HistoryPage> {
        const records = await this.#store.read(ctx, agentId);
        return { agentId, ...selectHistoryPage(records, query) };
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        readAgentHistoryTool(this, scope.agent.id),
    ];

    /**
     * Follow the response as it streams, keeping each completed block.
     *
     * Observation only: this runs on the event path the agent is answering on, so it accumulates
     * in memory and writes nothing. What it collects becomes one message when the response ends.
     */
    readonly onEvent = (_ctx: Context, scope: AgentFeatureScope, event: SessionEvent): void => {
        const pending = this.#pendingFor(scope.agent.id);
        if (event.type === "text_start") pending.text = "";
        else if (event.type === "text_delta") pending.text += event.delta;
        else if (event.type === "text_end") {
            if (pending.text.length > 0) pending.blocks.push({ type: "text", text: pending.text });
            pending.text = "";
        } else if (event.type === "reasoning_start") pending.reasoning = "";
        else if (event.type === "reasoning_delta") pending.reasoning += event.delta;
        else if (event.type === "reasoning_end") {
            // A provider that signs or encrypts its reasoning exposes none of it. That the model
            // thought is worth recording; pretending to know what it thought is not.
            pending.blocks.push(
                pending.reasoning.length > 0
                    ? { type: "thinking", thinking: pending.reasoning }
                    : { type: "thinking", thinking: "", redacted: true },
            );
            pending.reasoning = "";
        } else if (event.type === "toolcall_end") {
            pending.blocks.push({
                type: "tool_call",
                callId: event.callId,
                name: pending.names.get(event.callId) ?? event.callId,
                arguments: parseArguments(event.arguments),
            });
            pending.names.delete(event.callId);
        } else if (event.type === "toolcall_start") {
            pending.names.set(event.callId, event.name);
        }
    };

    /**
     * Write the finished response as one message, and the failure as one of its own when the
     * response failed. A response that produced nothing records nothing.
     */
    readonly afterInference = async (
        ctx: Context,
        scope: AgentFeatureScope,
        inference: AgentBaseInference,
    ): Promise<void> => {
        const pending = this.#pending.get(scope.agent.id);
        this.#pending.delete(scope.agent.id);
        const attribution = {
            at: Date.now(),
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
        };
        const messages: HistoryMessage[] = [];
        if (pending !== undefined && pending.blocks.length > 0) {
            messages.push({ role: "assistant", blocks: pending.blocks, ...attribution });
        }
        if (inference.errorMessage !== undefined) {
            messages.push({
                role: "error",
                blocks: [{ type: "text", text: inference.errorMessage }],
                ...attribution,
            });
        }
        if (messages.length === 0) return;
        try {
            await this.#store.append(ctx, scope.agent.id, messages);
        } catch {
            // History is a record of the run, never a condition of it.
        }
    };

    /**
     * Record what a tool answered, once it has answered.
     *
     * Recording is deliberately outside the call's own success: this hook decides whether the
     * tool ran, so a store that is slow or broken must not turn a completed tool into a failed
     * one. The result reaches the model either way.
     */
    readonly aroundToolExecution = async (
        ctx: Context,
        scope: AgentFeatureScope,
        execution: AgentBaseToolExecution,
    ): Promise<unknown> => {
        try {
            const result = await execution.execute();
            await this.#recordToolResult(ctx, scope, execution, result, false);
            return result;
        } catch (error) {
            await this.#recordToolResult(ctx, scope, execution, describeError(error), true);
            throw error;
        }
    };

    /** What this agent's response has produced so far, started if it has produced nothing. */
    #pendingFor(agentId: string): PendingResponse {
        const existing = this.#pending.get(agentId);
        if (existing !== undefined) return existing;
        const created: PendingResponse = {
            blocks: [],
            names: new Map(),
            reasoning: "",
            text: "",
        };
        this.#pending.set(agentId, created);
        return created;
    }

    /** Append one tool result, swallowing whatever the store thinks of it. */
    async #recordToolResult(
        ctx: Context,
        scope: AgentFeatureScope,
        execution: AgentBaseToolExecution,
        result: unknown,
        isError: boolean,
    ): Promise<void> {
        try {
            await this.#store.append(ctx, scope.agent.id, [
                {
                    role: "assistant",
                    blocks: [
                        {
                            type: "tool_result",
                            callId: execution.callId,
                            toolName: execution.tool.name,
                            output: this.#renderToolOutput(execution, result, isError),
                            ...(isError ? { isError: true } : {}),
                        },
                    ],
                    at: Date.now(),
                },
            ]);
        } catch {
            // History is a record of the run, never a condition of it.
        }
    }

    /** What the tool answered, as the bounded text a reader can make sense of. */
    #renderToolOutput(
        execution: AgentBaseToolExecution,
        result: unknown,
        isError: boolean,
    ): string {
        const text = isError ? String(result) : renderResult(execution.tool, result);
        return text.length <= this.#toolOutputLimit
            ? text
            : `${text.slice(0, this.#toolOutputLimit)}\n...[truncated ${text.length - this.#toolOutputLimit} chars]`;
    }
}

/** One response as it streams: the blocks it has finished, and the one it is still writing. */
interface PendingResponse {
    /** Blocks completed so far, in the order the model produced them. */
    readonly blocks: HistoryBlock[];
    /** The names of tool calls that have started, until their arguments arrive. */
    readonly names: Map<string, string>;
    /** Reasoning accumulated for the block being written. */
    reasoning: string;
    /** Text accumulated for the block being written. */
    text: string;
}

/** The call's arguments as data when they parse, and as the raw text when they do not. */
function parseArguments(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/** What the model was shown for this result, as text. */
function renderResult(tool: AnyAgentTool, result: unknown): string {
    try {
        return tool
            .toLLM(result)
            .map((block) =>
                block.type === "text" ? block.text : `[${block.type} output: ${block.mimeType}]`,
            )
            .join("\n");
    } catch {
        return stringify(result);
    }
}

/** A structured value as text, however it resists. */
function stringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/** What went wrong, in the words the failure used. */
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
