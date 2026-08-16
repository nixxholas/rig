import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentModule,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type {
    SessionOutputBlock,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { sql, type SQL } from "drizzle-orm";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";

import {
    historyBlockSchema,
    historyMessageSchema,
    historyMessageInputSchema,
    historyMessageWithinPersistenceBounds,
    historyAgentIdSchema,
    MAX_HISTORY_BLOCKS_PER_PAGE,
    MAX_HISTORY_CALL_ID_LENGTH,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_PENDING_BLOCKS,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_TOTAL_MESSAGES,
    MAX_HISTORY_TOOL_NAME_LENGTH,
    historyToolArgumentsSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
    historyToolArgumentsWithinByteLimit,
    MAX_HISTORY_TOOL_DISPLAY_LENGTH,
    MAX_HISTORY_TOOL_OUTPUT_LENGTH,
    type HistoryBlock,
    type HistoryMessage,
    type HistoryMessageInput,
} from "./HistoryMessage.js";
import {
    historyPageSchema,
    historyQuerySchema,
    type HistoryPage,
    type HistoryQuery,
} from "./HistoryPage.js";
import {
    historyAgentSummariesSchema,
    historyAgentTargetSchema,
    type HistoryAgentSummaries,
} from "./HistoryAgent.js";
import {
    historyContextSchema,
    historyRecordSchema,
    historyStoreQuerySchema,
    type HistoryRecord,
    type HistoryStoreQuery,
} from "./HistoryStore.js";
import {
    historyMessageSearchParts,
    foldHistorySearchText,
} from "./impl/messageMatchesHistoryFilters.js";
import {
    historyStatsSchema,
    summarizeHistory,
    type HistoryStats,
} from "./impl/summarizeHistory.js";
import { readAgentHistoryTool } from "./tools/read_agent_history.js";

type HistoryToolArguments = Static<typeof historyToolArgumentsSchema>;

const PENDING_BLOCKS_KEY = "pending_blocks";
const TOOL_NAME_KEY = "tool_name";
const pendingBlocksSchema = Type.Array(historyBlockSchema, { maxItems: 2_048 });
const DEFAULT_READER_LIMIT = 200;
const positiveIntegerSchema = Type.Integer({ minimum: 1 });
const nonNegativeIntegerSchema = Type.Integer({ maximum: 1_000_000, minimum: 0 });
/** How much tool output is recorded before the rest is dropped as not worth keeping. */
const DEFAULT_TOOL_OUTPUT_LIMIT = 16_000;
const HISTORY_TABLE = "happy_agent_module_history";

const historyAppendListenerSchema = Type.Function(
    [
        historyContextSchema,
        historyAgentIdSchema,
        Type.Array(historyMessageSchema, { maxItems: MAX_HISTORY_MESSAGES_PER_APPEND }),
    ],
    Type.Unknown(),
);

const historyToolDisplayTextSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HISTORY_TOOL_DISPLAY_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/** The bounded information available to a host-provided tool-result summary formatter. */
export const historyToolDisplayInputSchema = Type.Object(
    {
        callId: Type.String({
            minLength: 1,
            maxLength: MAX_HISTORY_CALL_ID_LENGTH,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
        isError: Type.Optional(Type.Boolean()),
        output: Type.String({ maxLength: MAX_HISTORY_TOOL_OUTPUT_LENGTH }),
        toolName: Type.String({
            minLength: 1,
            maxLength: MAX_HISTORY_TOOL_NAME_LENGTH,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyToolDisplayInputSchema}. */
export type HistoryToolDisplayInput = Static<typeof historyToolDisplayInputSchema>;

const historyToolDisplaySchema = Type.Function(
    [historyContextSchema, historyToolDisplayInputSchema],
    Type.Union([historyToolDisplayTextSchema, Type.Promise(historyToolDisplayTextSchema)]),
);

const historyModuleOptionsSchema = Type.Object(
    {
        resolveTarget: Type.Optional(
            Type.Function(
                [historyContextSchema, historyAgentIdSchema, historyAgentTargetSchema],
                Type.Union([
                    historyAgentIdSchema,
                    Type.Undefined(),
                    Type.Promise(Type.Union([historyAgentIdSchema, Type.Undefined()])),
                ]),
            ),
        ),
        listAgents: Type.Optional(
            Type.Function(
                [historyContextSchema, historyAgentIdSchema],
                Type.Union([
                    historyAgentSummariesSchema,
                    Type.Promise(historyAgentSummariesSchema),
                ]),
            ),
        ),
        toolDisplay: Type.Optional(historyToolDisplaySchema),
        toolOutputLimit: Type.Optional(nonNegativeIntegerSchema),
        failureMode: Type.Optional(
            Type.Union([Type.Literal("best-effort"), Type.Literal("propagate")]),
        ),
        onAppend: Type.Optional(historyAppendListenerSchema),
        onPostCommitError: Type.Optional(
            Type.Function([historyContextSchema, Type.Unknown()], Type.Unknown()),
        ),
    },
    { additionalProperties: false },
);

/** Runtime contract for a configured history module. */
export { historyModuleOptionsSchema };
/** What a history module is built with. */
export type HistoryModuleOptions = Static<typeof historyModuleOptionsSchema>;

/**
 * The agent's own record of what happened, which it can read back.
 *
 * This is not the model's context. The context is what the provider is replaying right now, and
 * it is compacted, reset, and thrown away as the conversation moves; the history is what was
 * said and done, kept whether or not any model can still see it. The two are deliberately
 * separate: a conversation reset by an incompatible model switch loses its context entirely and
 * loses none of its history.
 *
 * The module writes as the agent works — every accepted user message, every completed assistant
 * response, every tool result, and every failed inference — from inside the transactions that
 * commit that work, so the record and the thing recorded become durable together. Completed
 * assistant blocks are kept in the run-scoped Agent KV rather than an in-memory map, so rollback
 * and restart do not leave the module with a second, contradictory notion of a run.
 *
 * Reading is the `read_agent_history` tool for the model, and `read` for everyone else, both
 * over the same paging, searching, and bounding.
 */
export class HistoryModule implements AgentModule {
    readonly name = "history";

    readonly #resolveTarget: HistoryModuleOptions["resolveTarget"];
    readonly #listAgents: HistoryModuleOptions["listAgents"];
    readonly #toolDisplay: HistoryModuleOptions["toolDisplay"];
    /** How much of a tool's output is worth recording. */
    readonly #toolOutputLimit: number;
    /** Whether archive failures are deliberately contained. */
    readonly #failureMode: "best-effort" | "propagate";
    readonly #onAppend: HistoryModuleOptions["onAppend"];
    readonly #onPostCommitError: HistoryModuleOptions["onPostCommitError"];

    readonly migrations: readonly AgentModuleMigration[] = [
        [
            "001-history-records",
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql.raw(`
                        CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
                            agent_id TEXT NOT NULL,
                            position BIGINT NOT NULL,
                            record_id TEXT NOT NULL,
                            role TEXT NOT NULL,
                            message_json TEXT NOT NULL,
                            search_text TEXT NOT NULL,
                            assistant_messages BIGINT NOT NULL,
                            user_messages BIGINT NOT NULL,
                            text_characters BIGINT NOT NULL,
                            thinking_blocks BIGINT NOT NULL,
                            tool_calls BIGINT NOT NULL,
                            tool_results BIGINT NOT NULL,
                            PRIMARY KEY (agent_id, position),
                            UNIQUE (agent_id, record_id)
                        )
                    `),
                );
            },
        ],
    ];

    constructor(options: HistoryModuleOptions = {}) {
        if (!Value.Check(historyModuleOptionsSchema, options)) {
            throw new Error("History module options are invalid.");
        }
        this.#resolveTarget = options.resolveTarget;
        this.#listAgents = options.listAgents;
        this.#toolDisplay = options.toolDisplay;
        const toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
        if (!Value.Check(nonNegativeIntegerSchema, toolOutputLimit)) {
            throw new Error("History tool output retention must be a non-negative integer.");
        }
        this.#toolOutputLimit = toolOutputLimit;
        this.#failureMode = options.failureMode ?? "propagate";
        this.#onAppend = options.onAppend;
        this.#onPostCommitError = options.onPostCommitError;
    }

    /** Add a message to an agent's history. This is how a host records what it sent. */
    async record(ctx: Context, agentId: string, message: HistoryMessageInput): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyMessageInputSchema, message)
        ) {
            throw new Error("The history module received an invalid message.");
        }
        const normalized = {
            ...message,
            at: message.at ?? Date.now(),
            recordId: message.recordId ?? createRecordId(),
        };
        if (!Value.Check(historyMessageSchema, normalized)) {
            throw new Error("The history module produced an invalid message.");
        }
        await this.#direct(ctx, (txCtx) => this.#append(txCtx, agentId, normalized));
    }

    /** Everything an agent's history holds, oldest first. */
    async messages(
        ctx: Context,
        agentId: string,
        query: Pick<HistoryQuery, "from" | "limit">,
    ): Promise<HistoryRecord[]> {
        const input = {
            ...(query.from === undefined ? {} : { from: query.from }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
        };
        if (!Value.Check(historyQuerySchema, input)) {
            throw new Error("The history reader received an invalid page query.");
        }
        const page = await this.#direct(ctx, (txCtx) =>
            this.#readPage(txCtx, agentId, {
                limit: boundedLimit(query.limit ?? DEFAULT_READER_LIMIT),
                ...(query.from === undefined ? {} : { from: query.from }),
            }),
        );
        return [...page.messages];
    }

    /**
     * Return exact archive statistics through the store's bounded page operation.
     *
     * The module deliberately does not derive this from the records returned by a page: callers
     * such as model handoff may only retain a two-ended sample while still needing the archive's
     * full totals.
     */
    async stats(ctx: Context, agentId: string): Promise<HistoryStats> {
        const page = await this.#direct(ctx, (txCtx) =>
            this.#readPage(txCtx, agentId, {
                from: "start",
                limit: 1,
            }),
        );
        return page.totalStats;
    }

    /**
     * One page of an agent's history, filtered and paged the same way for every reader. The
     * page carries the messages themselves; rendering them within a size is `formatHistoryPage`.
     */
    async read(ctx: Context, agentId: string, query: HistoryQuery = {}): Promise<HistoryPage> {
        if (!Value.Check(historyQuerySchema, query)) {
            throw new Error("The history reader received an invalid page query.");
        }
        return await this.#direct(ctx, (txCtx) =>
            this.#readPage(txCtx, agentId, toStoreQuery(query)),
        );
    }

    /**
     * Return the bounded session-tree roster supplied by the host. Without a roster adapter the
     * module still describes the requesting agent, so the response contract remains useful for
     * self-history reads while cross-agent composition is being wired.
     */
    async listAgents(
        ctx: Context,
        requesterAgentId: string,
        targetAgentId = requesterAgentId,
    ): Promise<HistoryAgentSummaries> {
        if (
            !Value.Check(historyAgentIdSchema, requesterAgentId) ||
            !Value.Check(historyAgentIdSchema, targetAgentId)
        ) {
            throw new Error("The history roster identity is invalid.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            let summaries: HistoryAgentSummaries;
            if (this.#listAgents !== undefined) {
                summaries = await this.#listAgents(txCtx, requesterAgentId);
            } else {
                summaries = [];
                for (const agentId of new Set([requesterAgentId, targetAgentId])) {
                    const stats = await readHistoryStats(txCtx.db, sql`agent_id = ${agentId}`);
                    summaries.push({
                        agentId,
                        messageCount: stats.messages,
                        path: agentId,
                        status: "unknown",
                    });
                }
            }
            if (!Value.Check(historyAgentSummariesSchema, summaries)) {
                throw new Error("The history agent roster returned invalid summaries.");
            }
            const snapshot = structuredClone(summaries) as HistoryAgentSummaries;
            const ids = new Set<string>();
            for (const summary of snapshot) {
                if (ids.has(summary.agentId)) {
                    throw new Error("The history agent roster returned duplicate agent IDs.");
                }
                ids.add(summary.agentId);
            }
            if (!ids.has(requesterAgentId) || !ids.has(targetAgentId)) {
                throw new Error("The history agent roster omitted a requested agent.");
            }
            snapshot.sort(
                (left, right) =>
                    left.path.localeCompare(right.path) ||
                    left.agentId.localeCompare(right.agentId),
            );
            return snapshot;
        });
    }

    readonly tools = (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
        readAgentHistoryTool(this, scope.agent.id),
    ];

    /**
     * Resolve a tool target while keeping self-access available without host wiring. A host may
     * resolve either an Agent ID or a canonical session-tree path and should raise its own
     * not-found or ambiguous-path error before returning.
     */
    async resolveTarget(
        ctx: Context,
        requesterAgentId: string,
        requestedTarget: string,
    ): Promise<string | undefined> {
        if (
            !Value.Check(historyAgentIdSchema, requesterAgentId) ||
            !Value.Check(historyAgentTargetSchema, requestedTarget)
        ) {
            throw new Error("The history target identity is invalid.");
        }
        if (requestedTarget === requesterAgentId) return requestedTarget;
        const resolved = await this.#resolveTarget?.(ctx, requesterAgentId, requestedTarget);
        if (resolved !== undefined && !Value.Check(historyAgentIdSchema, resolved)) {
            throw new Error("The history target resolver returned an invalid agent ID.");
        }
        if (resolved === undefined && this.#resolveTarget !== undefined) {
            throw new Error(`Agent '${requestedTarget}' was not found in the session tree.`);
        }
        return resolved;
    }

    /**
     * Keep each completed block of the response in the run-scoped Agent KV.
     *
     * The event runs inside the transaction that appends the block to the agent's own durable
     * state. A block whose commit is rolled back is therefore never retained by this module, and
     * a process restart can resume from the same pending blocks without relying on heap state.
     */
    readonly onEventTransact = (
        ctx: Context,
        scope: AgentModuleScope,
        event: AgentBasePersistedEvent,
    ): Promise<void> => {
        return this.#appendPendingBlock(ctx, scope, toHistoryBlock(event));
    };

    /** Record an accepted user message beside the Agent Base message transaction. */
    readonly messageAcceptedTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        await this.#append(ctx, scope.agent.id, {
            at: Date.now(),
            blocks: accepted.message.content.map(toHistoryOutputBlock),
            recordId: createRecordId(),
            role: "user",
        });
    };

    /**
     * Remember the name before the base dispatches a tool. The call-scoped run KV survives the
     * dispatch and is visible to `afterToolCallTransact`, including after a restart.
     */
    readonly beforeToolCallTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        call: SessionToolCallBlock,
    ): Promise<void> => {
        const callBlock: HistoryBlock = {
            arguments: parseArguments(call.arguments),
            callId: call.callId,
            name: call.name,
            type: "tool_call",
        };
        if (
            !Value.Check(historyToolCallBlockSchema, callBlock) ||
            !historyToolArgumentsWithinByteLimit(callBlock.arguments)
        ) {
            throw new Error("History module received an invalid tool call.");
        }
        await scope.runKV.write(ctx, TOOL_NAME_KEY, call.name);
    };

    /** Record each tool result in the same transaction as the result in Agent Base history. */
    readonly afterToolCallTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        result: SessionToolResultMessage,
    ): Promise<void> => {
        const storedName = await scope.runKV.read(ctx, TOOL_NAME_KEY);
        const toolName = typeof storedName === "string" ? storedName : "unknown tool";
        const output = renderOutput(result.content, this.#toolOutputLimit);
        const displayInput = {
            callId: result.callId,
            ...(result.isError === undefined ? {} : { isError: result.isError }),
            output,
            toolName,
        };
        if (!Value.Check(historyToolDisplayInputSchema, displayInput)) {
            throw new Error("History module received an invalid tool-result display input.");
        }
        const display =
            this.#toolDisplay === undefined
                ? defaultToolDisplay(displayInput)
                : await this.#toolDisplay(ctx, displayInput);
        if (!Value.Check(historyToolDisplayTextSchema, display)) {
            throw new Error("History module received an invalid tool-result display.");
        }
        const toolResultBlock: HistoryBlock = {
            type: "tool_result",
            callId: result.callId,
            display,
            output,
            toolName,
            ...(result.isError === true ? { isError: true } : {}),
        };
        if (!Value.Check(historyToolResultBlockSchema, toolResultBlock)) {
            throw new Error("History module received an invalid tool result.");
        }
        await this.#append(ctx, scope.agent.id, {
            at: Date.now(),
            blocks: [toolResultBlock],
            recordId: createRecordId(),
            role: "assistant",
        });
    };

    /**
     * Write the finished response as one message, and the failure as one of its own when the
     * response failed. Both land in the transaction that commits the inference, so the record and
     * the thing recorded become durable together. A response that produced nothing records
     * nothing. In strict mode a store failure propagates and rolls back the inference transaction;
     * best-effort mode is an explicit opt-in and drops the record.
     */
    readonly afterInferenceTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        inference: AgentBaseInference,
    ): Promise<void> => {
        const blocks = await this.#pendingBlocks(ctx, scope);
        const responseId =
            blocks.length > 0 || inference.errorMessage !== undefined
                ? createRecordId()
                : undefined;
        const attribution = {
            at: Date.now(),
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
        };
        const messages: HistoryMessage[] = [];
        if (blocks.length > 0) {
            messages.push({
                role: "assistant",
                blocks,
                recordId: `${responseId}:assistant`,
                ...attribution,
            });
        }
        if (inference.errorMessage !== undefined) {
            messages.push({
                role: "error",
                blocks: [{ type: "text", text: inference.errorMessage }],
                recordId: `${responseId}:error`,
                ...attribution,
            });
        }
        if (messages.length === 0) {
            await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
            return;
        }
        await this.#append(ctx, scope.agent.id, ...messages);
        await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
    };

    /**
     * Finish an archive that was interrupted after its response blocks were committed.
     *
     * The settling transaction is the last place the run KV is available. A strict archive
     * failure therefore rolls settlement back and leaves the pending blocks for the next restart.
     */
    readonly afterAgentSettledTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<void> => {
        const blocks = await this.#pendingBlocks(ctx, scope);
        if (blocks.length === 0) return;
        await this.#append(ctx, scope.agent.id, {
            at: Date.now(),
            blocks,
            recordId: createRecordId(),
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
            role: "assistant",
        });
        await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
    };

    async #appendPendingBlock(
        ctx: Context,
        scope: AgentModuleScope,
        block: HistoryBlock,
    ): Promise<void> {
        const pending = await this.#pendingBlocks(ctx, scope);
        if (pending.length >= MAX_HISTORY_PENDING_BLOCKS) {
            throw new Error("History module reached its pending block limit.");
        }
        if (
            !Value.Check(historyBlockSchema, block) ||
            (block.type === "tool_call" && !historyToolArgumentsWithinByteLimit(block.arguments))
        ) {
            throw new Error("History module received an invalid pending block.");
        }
        await scope.runKV.write(ctx, PENDING_BLOCKS_KEY, [...pending, block]);
    }

    async #pendingBlocks(ctx: Context, scope: AgentModuleScope): Promise<HistoryBlock[]> {
        const value = await scope.runKV.read(ctx, PENDING_BLOCKS_KEY);
        if (value === undefined) return [];
        if (!Value.Check(pendingBlocksSchema, value)) {
            throw new Error("History module found invalid pending blocks.");
        }
        return value as HistoryBlock[];
    }

    async #append(
        ctx: Context,
        agentId: string,
        ...messages: readonly HistoryMessage[]
    ): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            messages.length > MAX_HISTORY_MESSAGES_PER_APPEND ||
            messages.some((message) => !historyMessageWithinPersistenceBounds(message))
        ) {
            throw new Error("The history module produced an invalid archive append.");
        }
        try {
            const countRows = await agentDatabaseRows<{ count: number | string }>(
                ctx.db,
                sql`SELECT COUNT(*) AS count
                    FROM ${sql.raw(HISTORY_TABLE)}
                    WHERE agent_id = ${agentId}`,
            );
            const count = toSafeInteger(countRows[0]?.count, "history record count");
            if (count + messages.length > MAX_HISTORY_TOTAL_MESSAGES) {
                throw new Error("The history module reached its record limit.");
            }
            const positionRows = await agentDatabaseRows<{ position: number | string }>(
                ctx.db,
                sql`SELECT COALESCE(MAX(position), -1) + 1 AS position
                    FROM ${sql.raw(HISTORY_TABLE)}
                    WHERE agent_id = ${agentId}`,
            );
            let position = toSafeInteger(positionRows[0]?.position, "history record position");
            for (const message of messages) {
                const encoded = JSON.stringify(message);
                if (encoded === undefined) {
                    throw new Error("The history module could not serialize a message.");
                }
                const stats = summarizeHistory([message]);
                const searchText = foldHistorySearchText(
                    historyMessageSearchParts(message).join("\n"),
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`INSERT INTO ${sql.raw(HISTORY_TABLE)} (
                            agent_id,
                            position,
                            record_id,
                            role,
                            message_json,
                            search_text,
                            assistant_messages,
                            user_messages,
                            text_characters,
                            thinking_blocks,
                            tool_calls,
                            tool_results
                        ) VALUES (
                            ${agentId},
                            ${position},
                            ${message.recordId},
                            ${message.role},
                            ${encoded},
                            ${searchText},
                            ${stats.assistantMessages},
                            ${stats.userMessages},
                            ${stats.textCharacters},
                            ${stats.thinkingBlocks},
                            ${stats.toolCalls},
                            ${stats.toolResults}
                        )`,
                );
                position += 1;
            }
            this.#scheduleAppendNotification(ctx, agentId, messages);
        } catch (error: unknown) {
            if (this.#failureMode === "best-effort") return;
            throw error;
        }
    }

    async #readPage(ctx: Context, agentId: string, query: HistoryStoreQuery): Promise<HistoryPage> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyStoreQuerySchema, query)
        ) {
            throw new Error("The history reader received an invalid store query.");
        }
        const requestedLimit = boundedLimit(query.limit);
        const filters = historyWhere(agentId, query);
        const totalStats = await readHistoryStats(ctx.db, sql`agent_id = ${agentId}`);
        const matchedStats = await readHistoryStats(ctx.db, filters);
        const totalMessages = totalStats.messages;
        const matchedMessages = matchedStats.messages;
        const maxRows = await agentDatabaseRows<{ position: number | string | null }>(
            ctx.db,
            sql`SELECT MAX(position) AS position
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId}`,
        );
        const archiveLastPosition =
            maxRows[0]?.position === null || maxRows[0]?.position === undefined
                ? undefined
                : toSafeInteger(maxRows[0].position, "history last position");
        const archiveEnd =
            archiveLastPosition === undefined
                ? 0
                : archiveLastPosition >= MAX_HISTORY_POSITION
                  ? MAX_HISTORY_POSITION
                  : archiveLastPosition + 1;
        const anchor = query.cursor ?? 0;
        const selectedRows =
            query.from === "end"
                ? await agentDatabaseRows<HistoryRow>(
                      ctx.db,
                      sql`SELECT position, record_id, message_json
                          FROM ${sql.raw(HISTORY_TABLE)}
                          WHERE ${filters}
                          ORDER BY position DESC
                          LIMIT ${requestedLimit}`,
                  )
                : await agentDatabaseRows<HistoryRow>(
                      ctx.db,
                      sql`SELECT position, record_id, message_json
                          FROM ${sql.raw(HISTORY_TABLE)}
                          WHERE ${sql.join([filters, sql`position >= ${anchor}`], sql` AND `)}
                          ORDER BY position ASC
                          LIMIT ${requestedLimit}`,
                  );
        const selectedRowsChronological =
            query.from === "end" ? [...selectedRows].reverse() : [...selectedRows];
        const messages = selectedRowsChronological.map(toHistoryRecord);
        const startIndex =
            query.from === "end"
                ? Math.max(0, matchedMessages - requestedLimit)
                : await countHistoryRows(ctx.db, sql`(${filters}) AND position < ${anchor}`);
        const selectedFirstPosition = messages[0]?.position;
        const lastSelectedPosition = messages.at(-1)?.position;
        const nextCursor =
            query.from === "end" || lastSelectedPosition === undefined
                ? undefined
                : await firstHistoryPosition(
                      ctx.db,
                      sql`(${filters}) AND position > ${lastSelectedPosition}`,
                  );
        const previousOffset = Math.max(0, startIndex - requestedLimit);
        const previousCursor =
            matchedMessages > messages.length &&
            (query.from === "end" || query.cursor !== undefined || startIndex > 0)
                ? await historyPositionAt(ctx.db, filters, previousOffset)
                : undefined;
        const cursor =
            selectedFirstPosition ?? (query.from === "end" ? archiveEnd : (query.cursor ?? 0));
        const page: HistoryPage = {
            agentId,
            cursor,
            matchedMessages,
            matchedStats,
            messages,
            ...(nextCursor === undefined ? {} : { nextCursor }),
            ...(previousCursor === undefined ? {} : { previousCursor }),
            totalMessages,
            totalStats,
        };
        if (!Value.Check(historyPageSchema, page) || page.agentId !== agentId) {
            throw new Error("The history module produced an invalid history page.");
        }
        if (page.messages.length > requestedLimit) {
            throw new Error("The history module returned more records than requested.");
        }
        if (page.messages.length > page.matchedMessages) {
            throw new Error("The history module returned more records than matched.");
        }
        if (
            query.from !== "end" &&
            page.messages.length > 0 &&
            page.matchedMessages > page.messages.length &&
            page.nextCursor === undefined
        ) {
            throw new Error("The history module omitted a cursor for a nonterminal page.");
        }
        if (page.matchedMessages > 0 && page.messages.length === 0 && query.cursor === undefined) {
            throw new Error("The history module returned an empty nonterminal page.");
        }
        const requiresPreviousCursor =
            (query.from === "end" && page.matchedMessages > page.messages.length) ||
            (query.cursor !== undefined && page.messages.length === 0 && page.matchedMessages > 0);
        if (requiresPreviousCursor && page.previousCursor === undefined) {
            throw new Error("The history module omitted a cursor for an older page.");
        }
        if (
            page.matchedMessages < page.messages.length ||
            page.totalMessages < page.matchedMessages ||
            page.matchedStats.messages !== page.matchedMessages ||
            page.totalStats.messages !== page.totalMessages ||
            !statsCountsConsistent(page.matchedStats) ||
            !statsCountsConsistent(page.totalStats) ||
            !statsAtLeast(page.totalStats, page.matchedStats)
        ) {
            throw new Error("The history module returned inconsistent page statistics.");
        }
        const selectedStats = summarizeHistory(page.messages.map((record) => record.message));
        const selectedBlockCount = page.messages.reduce(
            (total, record) => total + record.message.blocks.length,
            0,
        );
        if (selectedBlockCount > MAX_HISTORY_BLOCKS_PER_PAGE) {
            throw new Error("The history module returned too many blocks for one page.");
        }
        if (!statsAtLeast(page.matchedStats, selectedStats)) {
            throw new Error("The history module returned inconsistent selected statistics.");
        }
        if (
            query.roles === undefined &&
            (query.query === undefined || query.query.trim().length === 0) &&
            !statsEqual(page.matchedStats, page.totalStats)
        ) {
            throw new Error("The history module returned inconsistent unfiltered statistics.");
        }
        const recordIds = new Set<string>();
        let previousPosition = -1;
        for (const record of page.messages) {
            if (
                !Value.Check(historyRecordSchema, record) ||
                record.position <= previousPosition ||
                recordIds.has(record.message.recordId)
            ) {
                throw new Error("The history module returned an invalid record.");
            }
            recordIds.add(record.message.recordId);
            previousPosition = record.position;
        }
        const firstPosition = page.messages[0]?.position;
        const lastPosition = page.messages.at(-1)?.position;
        if (firstPosition !== undefined && page.cursor !== firstPosition) {
            throw new Error("The history store returned an invalid page cursor.");
        }
        if (query.cursor !== undefined && page.cursor < query.cursor) {
            throw new Error("The history module moved the cursor backwards.");
        }
        if (page.nextCursor !== undefined) {
            if (
                page.messages.length === 0 ||
                lastPosition === undefined ||
                page.nextCursor <= lastPosition ||
                page.nextCursor <= (query.cursor ?? -1)
            ) {
                throw new Error("The history module returned a stalled next cursor.");
            }
        }
        if (page.previousCursor !== undefined) {
            const lowerBound = firstPosition ?? query.cursor;
            if (lowerBound !== undefined && page.previousCursor >= lowerBound) {
                throw new Error("The history module returned a stalled previous cursor.");
            }
        }
        if (
            page.nextCursor !== undefined &&
            page.messages.length > 0 &&
            page.nextCursor > MAX_HISTORY_POSITION
        ) {
            throw new Error("The history module returned an out-of-bounds next cursor.");
        }
        return page;
    }

    async #direct<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await ctx.inTx(work);
    }

    #scheduleAppendNotification(
        ctx: Context,
        agentId: string,
        messages: readonly HistoryMessage[],
    ): void {
        if (this.#onAppend === undefined) return;
        const snapshot = structuredClone(messages) as HistoryMessage[];
        afterCommit(ctx, async (postCommitCtx) => {
            try {
                await this.#onAppend?.(postCommitCtx, agentId, snapshot);
            } catch (error: unknown) {
                try {
                    await this.#onPostCommitError?.(postCommitCtx, error);
                } catch {
                    // Post-commit observation cannot turn a committed archive into a failure.
                }
            }
        });
    }
}

interface HistoryRow {
    readonly position: number | string;
    readonly record_id: string;
    readonly message_json: string;
}

interface HistoryStatsRow {
    readonly messages: number | string;
    readonly assistant_messages: number | string;
    readonly user_messages: number | string;
    readonly text_characters: number | string;
    readonly thinking_blocks: number | string;
    readonly tool_calls: number | string;
    readonly tool_results: number | string;
}

function historyWhere(agentId: string, query: HistoryStoreQuery): SQL {
    const conditions: SQL[] = [sql`agent_id = ${agentId}`];
    if (query.roles !== undefined && query.roles.length > 0) {
        conditions.push(
            sql`role IN (${sql.join(
                query.roles.map((role) => sql`${role}`),
                sql`, `,
            )})`,
        );
    }
    const foldedQuery = query.query === undefined ? "" : foldHistorySearchText(query.query.trim());
    if (foldedQuery.length > 0) {
        const escaped = foldedQuery.replace(/[!%_]/g, (character) => `!${character}`);
        conditions.push(sql`search_text LIKE ${`%${escaped}%`} ESCAPE '!'`);
    }
    return sql.join(conditions, sql` AND `);
}

async function readHistoryStats(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
): Promise<HistoryStats> {
    const rows = await agentDatabaseRows<HistoryStatsRow>(
        database,
        sql`SELECT
                COUNT(*) AS messages,
                COALESCE(SUM(assistant_messages), 0) AS assistant_messages,
                COALESCE(SUM(user_messages), 0) AS user_messages,
                COALESCE(SUM(text_characters), 0) AS text_characters,
                COALESCE(SUM(thinking_blocks), 0) AS thinking_blocks,
                COALESCE(SUM(tool_calls), 0) AS tool_calls,
                COALESCE(SUM(tool_results), 0) AS tool_results
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("The history module could not read archive statistics.");
    const stats: HistoryStats = {
        assistantMessages: toSafeInteger(row.assistant_messages, "assistant message count"),
        messages: toSafeInteger(row.messages, "history message count"),
        textCharacters: toSafeInteger(row.text_characters, "history text count"),
        thinkingBlocks: toSafeInteger(row.thinking_blocks, "history thinking count"),
        toolCalls: toSafeInteger(row.tool_calls, "history tool-call count"),
        toolResults: toSafeInteger(row.tool_results, "history tool-result count"),
        userMessages: toSafeInteger(row.user_messages, "user message count"),
    };
    if (!Value.Check(historyStatsSchema, stats) || !statsCountsConsistent(stats)) {
        throw new Error("The history module read inconsistent archive statistics.");
    }
    return stats;
}

async function countHistoryRows(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
): Promise<number> {
    const rows = await agentDatabaseRows<{ count: number | string }>(
        database,
        sql`SELECT COUNT(*) AS count
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}`,
    );
    return toSafeInteger(rows[0]?.count, "history row count");
}

async function firstHistoryPosition(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
): Promise<number | undefined> {
    const rows = await agentDatabaseRows<{ position: number | string }>(
        database,
        sql`SELECT position
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}
            ORDER BY position ASC
            LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : toSafeInteger(rows[0].position, "history cursor");
}

async function historyPositionAt(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
    offset: number,
): Promise<number | undefined> {
    const rows = await agentDatabaseRows<{ position: number | string }>(
        database,
        sql`SELECT position
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}
            ORDER BY position ASC
            LIMIT 1 OFFSET ${offset}`,
    );
    return rows[0] === undefined ? undefined : toSafeInteger(rows[0].position, "history cursor");
}

function toHistoryRecord(row: HistoryRow): HistoryRecord {
    const message = parseStoredMessage(row.message_json);
    const position = toSafeInteger(row.position, "history position");
    if (row.record_id !== message.recordId) {
        throw new Error("The history module found a mismatched record identity.");
    }
    const record: HistoryRecord = { message, position };
    if (!Value.Check(historyRecordSchema, record)) {
        throw new Error("The history module found an invalid persisted record.");
    }
    return record;
}

function parseStoredMessage(encoded: string): HistoryMessage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(encoded);
    } catch {
        throw new Error("The history module found malformed persisted message JSON.");
    }
    if (
        !Value.Check(historyMessageSchema, parsed) ||
        !historyMessageWithinPersistenceBounds(parsed)
    ) {
        throw new Error("The history module found an invalid persisted message.");
    }
    return parsed;
}

function toSafeInteger(value: unknown, label: string): number {
    const number = typeof value === "bigint" ? Number(value) : Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error(`The history module received an invalid ${label}.`);
    }
    return number;
}

function statsAtLeast(actual: HistoryStats, expected: HistoryStats): boolean {
    return (
        actual.assistantMessages >= expected.assistantMessages &&
        actual.messages >= expected.messages &&
        actual.textCharacters >= expected.textCharacters &&
        actual.thinkingBlocks >= expected.thinkingBlocks &&
        actual.toolCalls >= expected.toolCalls &&
        actual.toolResults >= expected.toolResults &&
        actual.userMessages >= expected.userMessages
    );
}

function statsCountsConsistent(stats: HistoryStats): boolean {
    return (
        stats.assistantMessages + stats.userMessages <= stats.messages &&
        (stats.messages > 0 ||
            (stats.assistantMessages === 0 &&
                stats.textCharacters === 0 &&
                stats.thinkingBlocks === 0 &&
                stats.toolCalls === 0 &&
                stats.toolResults === 0 &&
                stats.userMessages === 0))
    );
}

function statsEqual(left: HistoryStats, right: HistoryStats): boolean {
    return (
        left.assistantMessages === right.assistantMessages &&
        left.messages === right.messages &&
        left.textCharacters === right.textCharacters &&
        left.thinkingBlocks === right.thinkingBlocks &&
        left.toolCalls === right.toolCalls &&
        left.toolResults === right.toolResults &&
        left.userMessages === right.userMessages
    );
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
function parseArguments(value: string): HistoryToolArguments {
    try {
        const parsed: unknown = JSON.parse(value);
        if (
            Value.Check(historyToolArgumentsSchema, parsed) &&
            historyToolArgumentsWithinByteLimit(parsed)
        ) {
            return parsed as HistoryToolArguments;
        }
    } catch {
        // Keep malformed provider JSON as its original bounded text. The block schema below
        // still rejects an over-sized value before it can enter pending KV.
    }
    return value;
}

function createRecordId(): string {
    return globalThis.crypto.randomUUID();
}

function toHistoryOutputBlock(block: SessionOutputBlock): HistoryBlock {
    return block.type === "text"
        ? { text: block.text, type: "text" }
        : { mediaType: block.mimeType, type: "image" };
}

function renderOutput(blocks: readonly SessionOutputBlock[], limit: number): string {
    const text = blocks
        .map((block) => (block.type === "text" ? block.text : `[${block.mimeType} image output]`))
        .join("\n");
    if (text.length <= limit && text.length <= MAX_HISTORY_TOOL_OUTPUT_LENGTH) return text;
    const suffix = `\n...[truncated ${Math.max(0, text.length - limit)} chars]`;
    const retained = Math.max(0, Math.min(limit, MAX_HISTORY_TOOL_OUTPUT_LENGTH - suffix.length));
    return `${text.slice(0, retained)}${suffix}`;
}

function defaultToolDisplay(input: HistoryToolDisplayInput): string {
    return input.isError === true
        ? `Tool ${input.toolName} failed.`
        : `Tool ${input.toolName} returned ${input.output.length} characters.`;
}

function boundedLimit(limit: number): number {
    if (!Value.Check(positiveIntegerSchema, limit)) {
        throw new Error("History page limit must be a positive integer.");
    }
    return Math.min(limit, MAX_HISTORY_PAGE_SIZE);
}

function toStoreQuery(query: HistoryQuery): HistoryStoreQuery {
    return {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.from === undefined ? {} : { from: query.from }),
        limit: boundedLimit(query.limit ?? 100),
        ...(query.query === undefined ? {} : { query: query.query }),
        ...(query.roles === undefined ? {} : { roles: query.roles }),
    };
}
