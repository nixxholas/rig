import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentModule,
    AgentModuleHooks,
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
import { afterCommit, withLogContext, type Context } from "@steve.kite/stdlib";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";

import { isUserOriginMetadata, senderAgentIdOf } from "../impl/messageOrigin.js";
import {
    historyBlockSchema,
    historyMessageSchema,
    historyMessageInputSchema,
    historyMessageWithinPersistenceBounds,
    historyAgentIdSchema,
    MAX_HISTORY_BLOCKS_PER_PAGE,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_PENDING_BLOCKS,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_TOTAL_MESSAGES,
    historyToolArgumentsSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
    historyToolArgumentsWithinByteLimit,
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
    historyRecordSchema,
    historyStoreQuerySchema,
    type HistoryRecord,
    type HistoryStoreQuery,
} from "./HistoryStore.js";
import { createHistoryExcerpt, type HistoryExcerpt } from "./impl/createHistoryExcerpt.js";
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
/** How much tool output is recorded before the rest is dropped as not worth keeping. */
const TOOL_OUTPUT_LIMIT = 16_000;
/** How many records one end of a two-ended excerpt may contribute. */
const EXCERPT_END_PAGE_SIZE = 100;
/** The most characters one excerpt may be asked to render into. */
export const MAX_HISTORY_EXCERPT_CHARACTERS = 200_000;
const excerptBudgetSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_HISTORY_EXCERPT_CHARACTERS,
});
const HISTORY_TABLE = "happy_agent_module_history";

/**
 * What a subscriber is handed once an append has committed.
 *
 * It runs after the outermost commit, so the archive it describes is already durable and nothing
 * the subscriber does can undo it. Each subscriber receives its own copy of the messages.
 */
export type HistoryAppendListener = (
    ctx: Context,
    agentId: string,
    messages: readonly HistoryMessage[],
) => void | Promise<void>;

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

    /** Who is watching the archive: the live subscriptions this module supervises. */
    readonly #appendListeners = new Set<HistoryAppendListener>();

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

    /**
     * Watch every append this module commits, and stop watching by calling what is returned.
     *
     * A subscriber is called once the outermost transaction has committed, so what it is told
     * about is already durable. A subscriber that fails is reported through the context log and
     * never turns a committed archive into a failure.
     */
    onAppend(listener: HistoryAppendListener): () => void {
        this.#appendListeners.add(listener);
        return () => {
            this.#appendListeners.delete(listener);
        };
    }

    /** Add a message to an agent's history. This is how a caller records what it sent. */
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
     * The agents a reader may be told about: itself, and the agent it is reading.
     *
     * Every agent may read every agent's history, so this describes the two the request actually
     * concerns, each with the size of its own archive. An agent that has never recorded anything
     * is still described, with a count of zero, rather than left out of the answer.
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
            const summaries: HistoryAgentSummaries = [];
            for (const agentId of new Set([requesterAgentId, targetAgentId])) {
                const stats = await readHistoryStats(txCtx.db, sql`agent_id = ${agentId}`);
                summaries.push({
                    agentId,
                    messageCount: stats.messages,
                    path: agentId,
                    status: "unknown",
                });
            }
            summaries.sort(
                (left, right) =>
                    left.path.localeCompare(right.path) ||
                    left.agentId.localeCompare(right.agentId),
            );
            if (!Value.Check(historyAgentSummariesSchema, summaries)) {
                throw new Error("The history module produced an invalid agent roster.");
            }
            return summaries;
        });
    }

    /**
     * Resolve a tool target. Any agent may read any agent's history, so a target is simply the
     * Agent ID to read: its own, or another's. A target that exists nowhere is still a valid
     * request and simply has an empty archive — reading grants nothing and reaches nothing
     * outside the collection's own store. Anything that is not a well-formed Agent ID is refused
     * rather than guessed at.
     */
    async resolveTarget(
        _ctx: Context,
        requesterAgentId: string,
        requestedTarget: string,
    ): Promise<string> {
        if (
            !Value.Check(historyAgentIdSchema, requesterAgentId) ||
            !Value.Check(historyAgentTargetSchema, requestedTarget)
        ) {
            throw new Error("The history target identity is invalid.");
        }
        if (requestedTarget === requesterAgentId) return requestedTarget;
        if (!Value.Check(historyAgentIdSchema, requestedTarget)) {
            throw new Error(`Target '${requestedTarget}' is not an Agent ID.`);
        }
        return requestedTarget;
    }

    /**
     * The two ends of an agent's history, rendered within a character budget, with what the whole
     * archive amounts to.
     *
     * Both ends matter and the middle rarely does: the beginning is where the work was asked for,
     * and the end is where it was left. The two bounded reads are merged and deduplicated, so a
     * history short enough to appear in both is quoted once. The counts are the archive's exact
     * totals, and fall back to counting only the sample — saying so — in the degenerate case where
     * the totals cannot account for what was sampled.
     *
     * Returns nothing when the agent has no history at all, which is not an error: an agent that
     * recorded nothing has nothing to excerpt.
     */
    async readExcerpt(
        ctx: Context,
        agentId: string,
        maxCharacters: number,
    ): Promise<HistoryExcerpt | undefined> {
        if (!Value.Check(historyAgentIdSchema, agentId)) {
            throw new Error("The history excerpt received an invalid agent ID.");
        }
        if (!Value.Check(excerptBudgetSchema, maxCharacters)) {
            throw new Error("A history excerpt budget must be a bounded positive integer.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const beginning = await this.#readPage(txCtx, agentId, {
                from: "start",
                limit: EXCERPT_END_PAGE_SIZE,
            });
            const recent = await this.#readPage(txCtx, agentId, {
                from: "end",
                limit: EXCERPT_END_PAGE_SIZE,
            });
            const records = mergeHistoryRecords(beginning.messages, recent.messages);
            if (records.length === 0) return undefined;
            const sampled = summarizeHistory(records.map((record) => record.message));
            const total = beginning.totalStats;
            return createHistoryExcerpt(
                records,
                maxCharacters,
                statsAtLeast(total, sampled) ? total : undefined,
            );
        });
    }

    async #afterToolCall(
        ctx: Context,
        scope: AgentModuleScope,
        result: SessionToolResultMessage,
    ): Promise<void> {
        const storedName = await scope.runKV.read(ctx, TOOL_NAME_KEY);
        const toolName = typeof storedName === "string" ? storedName : "unknown tool";
        const output = renderOutput(result.content, TOOL_OUTPUT_LIMIT);
        const toolResultBlock: HistoryBlock = {
            type: "tool_result",
            callId: result.callId,
            display: toolDisplay(toolName, output, result.isError === true),
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
    }

    async #afterInference(
        ctx: Context,
        scope: AgentModuleScope,
        inference: AgentBaseInference,
    ): Promise<void> {
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
    }

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
            const searchText = foldHistorySearchText(historyMessageSearchParts(message).join("\n"));
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
                      sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                          FROM ${sql.raw(HISTORY_TABLE)}
                          WHERE ${filters}
                          ORDER BY position DESC
                          LIMIT ${requestedLimit}`,
                  )
                : await agentDatabaseRows<HistoryRow>(
                      ctx.db,
                      sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
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
        // Only matches at or after the anchor can still be reached going forward: the ones before
        // it were already passed, and comparing against the archive-wide total would demand a next
        // cursor from a page that genuinely ends the archive.
        const matchedFromAnchor = matchedMessages - startIndex;
        if (
            query.from !== "end" &&
            page.messages.length > 0 &&
            matchedFromAnchor > page.messages.length &&
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
        if (this.#appendListeners.size === 0) return;
        // Who is subscribed is settled here, before the commit, so a subscription taken or dropped
        // while the transaction was still open decides this notification once rather than racing it.
        const listeners = [...this.#appendListeners];
        const snapshot = structuredClone(messages) as HistoryMessage[];
        afterCommit(ctx, async (postCommitCtx) => {
            for (const listener of listeners) {
                try {
                    // Each subscriber gets its own copy, so one that keeps or edits what it was
                    // handed cannot change what the next one sees, or what the archive holds.
                    await listener(postCommitCtx, agentId, structuredClone(snapshot));
                } catch (error: unknown) {
                    // The archive is already durable. Observation cannot undo it, so a failing
                    // subscriber is reported and the rest are still told.
                    withLogContext(postCommitCtx, { agentId }).log.error(
                        "A history append subscriber failed.",
                        error,
                    );
                }
            }
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            readAgentHistoryTool(this, scope.agent.id),
        ],

        /**
         * Keep each completed block of the response in the run-scoped Agent KV.
         *
         * The event runs inside the transaction that appends the block to the agent's own
         * durable state. A block whose commit is rolled back is therefore never retained by this
         * module, and a process restart can resume from the same pending blocks without relying
         * on heap state.
         */
        onEventTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): Promise<void> => {
            return this.#appendPendingBlock(ctx, scope, toHistoryBlock(event));
        },

        /**
         * Record an accepted incoming message beside the Agent Base message transaction. Who
         * sent it is recorded from the message's provenance metadata while it still exists: only
         * a message positively stamped as an end-user submission is recorded as
         * `role: "user"`, and everything else — a goal continuation, a collaboration delivery, an
         * unstamped message — is recorded as `role: "agent"`, naming the specific sender when the
         * metadata named one. This fails closed: a forgetful path under-attributes rather than a
         * synthetic message impersonating the person.
         */
        messageAcceptedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => {
            const fromUser = isUserOriginMetadata(accepted.metadata);
            const sender = fromUser ? undefined : senderAgentIdOf(accepted.metadata);
            // A message from another agent may carry the reasoning that agent exposed. It is
            // recorded as thinking, the way this module records any other reasoning; reasoning
            // that is only an opaque provider payload has nothing to show and is left out.
            const blocks = accepted.message.content.flatMap((block): HistoryBlock[] => {
                if (block.type !== "reasoning") return [toHistoryOutputBlock(block)];
                return block.text === undefined ? [] : [{ type: "thinking", thinking: block.text }];
            });
            await this.#append(ctx, scope.agent.id, {
                at: Date.now(),
                blocks,
                recordId: createRecordId(),
                role: fromUser ? "user" : "agent",
                ...(sender === undefined ? {} : { senderAgentId: sender }),
            });
        },

        /**
         * Remember the name before the base dispatches a tool. The call-scoped run KV survives
         * the dispatch and is visible to `afterToolCallTransact`, including after a restart.
         */
        beforeToolCallTransact: async (
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
        },

        /** Record each tool result in the same transaction as the result in Agent Base history. */
        afterToolCallTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            result: SessionToolResultMessage,
        ): Promise<void> => this.#afterToolCall(ctx, scope, result),

        /**
         * Write the finished response as one message, and the failure as one of its own when the
         * response failed. Both land in the transaction that commits the inference, so the
         * record and the thing recorded become durable together. A response that produced
         * nothing records nothing. A store failure propagates and rolls back the inference
         * transaction, because a conversation the archive could not record is not one the agent
         * should go on to claim it remembers.
         */
        afterInferenceTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): Promise<void> => this.#afterInference(ctx, scope, inference),

        /**
         * Finish an archive that was interrupted after its response blocks were committed.
         *
         * The settling transaction is the last place the run KV is available. An archive failure
         * therefore rolls settlement back and leaves the pending blocks for the next restart.
         */
        afterAgentSettledTransact: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
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
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

interface HistoryRow {
    readonly position: number | string;
    readonly record_id: string;
    readonly role: string;
    readonly message_json: string;
    readonly search_text: string;
    readonly assistant_messages: number | string;
    readonly user_messages: number | string;
    readonly text_characters: number | string;
    readonly thinking_blocks: number | string;
    readonly tool_calls: number | string;
    readonly tool_results: number | string;
}

/** Every column a selected archive row is read back with, so all of it can be checked. */
const HISTORY_ROW_COLUMNS = `position,
                             record_id,
                             role,
                             message_json,
                             search_text,
                             assistant_messages,
                             user_messages,
                             text_characters,
                             thinking_blocks,
                             tool_calls,
                             tool_results`;

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
    if (query.roles !== undefined) {
        // Asking for no roles at all asks for nothing, exactly as the in-memory selector reads it.
        // Dropping the condition instead would quietly turn that into an unfiltered read.
        conditions.push(
            query.roles.length === 0
                ? sql`1 = 0`
                : sql`role IN (${sql.join(
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

/**
 * Rebuild one record from its row, and check the row against itself.
 *
 * Identity, role, search text, and the per-message counts are all denormalized copies of what the
 * stored message already says. A reader answers from those copies — it filters on `role`, searches
 * `search_text`, and sums the counts — so a row whose copies no longer agree with its own message
 * answers questions about a message that was never recorded. There is no safe repair for that, so
 * a disagreeing row fails the read rather than being quietly believed or quietly dropped.
 */
function toHistoryRecord(row: HistoryRow): HistoryRecord {
    const message = parseStoredMessage(row.message_json);
    const position = toSafeInteger(row.position, "history position");
    if (row.record_id !== message.recordId) {
        throw new Error("The history module found a mismatched record identity.");
    }
    if (row.role !== message.role) {
        throw new Error("The history module found a mismatched persisted role.");
    }
    if (row.search_text !== foldHistorySearchText(historyMessageSearchParts(message).join("\n"))) {
        throw new Error("The history module found a mismatched persisted search index.");
    }
    const stored: HistoryStats = {
        assistantMessages: toSafeInteger(row.assistant_messages, "assistant message count"),
        messages: 1,
        textCharacters: toSafeInteger(row.text_characters, "history text count"),
        thinkingBlocks: toSafeInteger(row.thinking_blocks, "history thinking count"),
        toolCalls: toSafeInteger(row.tool_calls, "history tool-call count"),
        toolResults: toSafeInteger(row.tool_results, "history tool-result count"),
        userMessages: toSafeInteger(row.user_messages, "user message count"),
    };
    if (!statsEqual(stored, summarizeHistory([message]))) {
        throw new Error("The history module found mismatched persisted statistics.");
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

/** The one line a person reading the history sees in place of a tool's whole answer. */
function toolDisplay(toolName: string, output: string, isError: boolean): string {
    return isError
        ? `Tool ${toolName} failed.`
        : `Tool ${toolName} returned ${output.length} characters.`;
}

/**
 * Join bounded pages read from opposite ends of one archive, in position order.
 *
 * A history short enough to appear in both pages is kept once. Both pages come from this module's
 * own validated read, so a position identifies the same record in either of them.
 */
function mergeHistoryRecords(...pages: readonly (readonly HistoryRecord[])[]): HistoryRecord[] {
    const byPosition = new Map<number, HistoryRecord>();
    for (const page of pages) {
        for (const record of page) byPosition.set(record.position, record);
    }
    return [...byPosition.values()].sort((left, right) => left.position - right.position);
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
