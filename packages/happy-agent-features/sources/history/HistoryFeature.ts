import type {
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentBaseToolOutcome,
    AgentFeature,
    AgentFeatureScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
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
 * every failed inference — from inside the transactions that commit that work, so the record and
 * the thing recorded become durable together. It never lets that writing decide anything: a store
 * that is slow or broken loses the record, not the run. What it cannot see, it is told: a user message belongs to
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
    /** Blocks of the response in progress, per agent, waiting for it to complete. */
    readonly #pending = new Map<string, HistoryBlock[]>();

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
     * Keep each completed block of the response in progress.
     *
     * The event runs inside the transaction that appends the block to the agent's own durable
     * state, so what is collected here is exactly what the agent kept: a block whose commit is
     * rolled back is never recorded. Collecting is all this does — it writes nothing, because a
     * failure here would roll that commit back.
     */
    readonly onEventTransact = (
        _ctx: Context,
        scope: AgentFeatureScope,
        event: AgentBasePersistedEvent,
    ): void => {
        this.#pendingFor(scope.agent.id).push(toHistoryBlock(event));
    };

    /**
     * Write the finished response as one message, and the failure as one of its own when the
     * response failed. Both land in the transaction that commits the inference, so the record and
     * the thing recorded become durable together. A response that produced nothing records
     * nothing, and a store that refuses costs the record rather than the run.
     */
    readonly afterInferenceTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        inference: AgentBaseInference,
    ): Promise<void> => {
        const blocks = this.#pending.get(scope.agent.id) ?? [];
        this.#pending.delete(scope.agent.id);
        const attribution = {
            at: Date.now(),
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
        };
        const messages: HistoryMessage[] = [];
        if (blocks.length > 0) {
            messages.push({ role: "assistant", blocks, ...attribution });
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
     * Record what a call answered, whether the tool produced it, a hook did, or a failure did.
     * The model has already been answered by this point, so a store that is slow or broken costs
     * the record and nothing else.
     */
    readonly afterToolCall = async (
        ctx: Context,
        scope: AgentFeatureScope,
        outcome: AgentBaseToolOutcome,
    ): Promise<void> => {
        try {
            await this.#store.append(ctx, scope.agent.id, [
                {
                    role: "assistant",
                    blocks: [
                        {
                            type: "tool_result",
                            callId: outcome.callId,
                            toolName: outcome.tool.name,
                            output: this.#renderToolOutput(outcome),
                            ...(outcome.isError ? { isError: true } : {}),
                        },
                    ],
                    at: Date.now(),
                },
            ]);
        } catch {
            // History is a record of the run, never a condition of it.
        }
    };

    /** The blocks this agent's response has finished so far, started when it is the first. */
    #pendingFor(agentId: string): HistoryBlock[] {
        const existing = this.#pending.get(agentId);
        if (existing !== undefined) return existing;
        const created: HistoryBlock[] = [];
        this.#pending.set(agentId, created);
        return created;
    }

    /** What the call answered, as the bounded text a reader can make sense of. */
    #renderToolOutput(outcome: AgentBaseToolOutcome): string {
        // What the model was told is what a reader of the history is looking at too, so the
        // record does not re-render the structured result into something the run never said.
        const text = outcome.content
            .map((block) =>
                block.type === "text" ? block.text : `[${block.type} output: ${block.mimeType}]`,
            )
            .join("\n");
        return text.length <= this.#toolOutputLimit
            ? text
            : `${text.slice(0, this.#toolOutputLimit)}\n...[truncated ${text.length - this.#toolOutputLimit} chars]`;
    }
}

/** The block a persisted event carries. */
function toHistoryBlock(event: AgentBasePersistedEvent): HistoryBlock {
    if (event.type === "text_end") return { type: "text", text: event.block.text };
    if (event.type === "reasoning_end") {
        // A provider that signs or encrypts its reasoning exposes none of it. That the model
        // thought is worth recording; pretending to know what it thought is not.
        return event.block.text === undefined
            ? { type: "thinking", thinking: "", redacted: true }
            : { type: "thinking", thinking: event.block.text };
    }
    return {
        type: "tool_call",
        callId: event.block.callId,
        name: event.block.name,
        arguments: parseArguments(event.block.arguments),
    };
}

/** The call's arguments as data when they parse, and as the raw text when they do not. */
function parseArguments(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}
