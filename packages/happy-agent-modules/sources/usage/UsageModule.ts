import {
    agentId as contextAgentId,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentBaseInference,
    type AgentBaseInferenceStart,
    type AgentBaseTurn,
    type AgentBaseTurnStart,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { usageEventSchema, usageModuleListenerSchema, type UsageEvent } from "./UsageEvent.js";
import {
    MAX_USAGE_DURATION_MS,
    MAX_USAGE_GROUPS,
    MAX_USAGE_OUTPUT_CHARACTERS,
    MAX_USAGE_PAGE_SIZE,
    MAX_USAGE_RECORDS,
    MAX_USAGE_TREE_PATH_LENGTH,
    MAX_USAGE_TREE_SESSIONS,
    MAX_USAGE_TOKEN_COUNT,
    usageAggregateQuerySchema,
    usageAgentIdSchema,
    usageAgentTreeSchema,
    usageIdSchema,
    usagePageQuerySchema,
    usagePageSchema,
    usageRecordSchema,
    usageSummarySchema,
    usageTimestampSchema,
    usageTokensSchema,
    type UsageAggregateQuery,
    type UsageAgentTree,
    type UsageInferenceRecord,
    type UsagePage,
    type UsagePageQuery,
    type UsageRecord,
    type UsageResetTarget,
    type UsageSummary,
    type UsageTokens,
    type UsageTurnRecord,
} from "./Usage.js";
import {
    usageAgentTreeAuthorizationSchema,
    usageAgentTreeReaderSchema,
    usageContextSchema,
    usageVoidOrPromiseVoidSchema,
    type UsageAgentTreeAuthorization,
    type UsageAgentTreeReader,
} from "./UsageContracts.js";
import { getAgentTreeUsageTool } from "./tools/get_agent_tree_usage.js";
import { getUsageTool } from "./tools/get_usage.js";
import { assertUsageRecord, assertUsageTokens } from "./impl/assertUsageRecord.js";
import { UsageDatabase } from "./impl/usageDatabase.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_GROUPS = 100;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 8_000;
const DEFAULT_MAX_OBSERVER_ERROR_LENGTH = 512;
const INFERENCE_PENDING_KEY = "pending_inference";
const TURN_PENDING_KEY = "pending_turn";

const usagePendingKindSchema = Type.Union([Type.Literal("inference"), Type.Literal("turn")]);
const usagePendingSchema = Type.Object(
    {
        startedAt: usageTimestampSchema,
    },
    { additionalProperties: false },
);
const usageFactoryKindSchema = Type.Literal("reset");
const usageFactoryResultSchema = Type.Union([usageIdSchema, Type.Promise(usageIdSchema)]);
const usageIdFactorySchema = Type.Function(
    [usageContextSchema, usageAgentIdSchema, usageFactoryKindSchema],
    usageFactoryResultSchema,
);
const usageClockSchema = Type.Function([], usageTimestampSchema);
const usageReadQuerySchema = Type.Object(
    {
        cursor: usageAggregateQuerySchema.properties.cursor,
        maxGroups: usageAggregateQuerySchema.properties.maxGroups,
    },
    { additionalProperties: false },
);
const usageModuleOptionsSchema = Type.Object(
    {
        clock: Type.Optional(usageClockSchema),
        idFactory: Type.Optional(usageIdFactorySchema),
        listener: Type.Optional(usageModuleListenerSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_PAGE_SIZE })),
        maxGroups: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_USAGE_GROUPS })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: MAX_USAGE_OUTPUT_CHARACTERS }),
        ),
        agentTreeReader: Type.Optional(usageAgentTreeReaderSchema),
        agentTreeAuthorization: Type.Optional(usageAgentTreeAuthorizationSchema),
        onObserverError: Type.Optional(
            Type.Function(
                [
                    usageContextSchema,
                    Type.String({ minLength: 1, maxLength: 64 }),
                    Type.String({
                        minLength: 1,
                        maxLength: DEFAULT_MAX_OBSERVER_ERROR_LENGTH,
                    }),
                ],
                usageVoidOrPromiseVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export { usageModuleOptionsSchema };
export type UsageModuleOptions = Static<typeof usageModuleOptionsSchema>;

type UsageFactoryKind = Static<typeof usageFactoryKindSchema>;
type UsagePendingKind = Static<typeof usagePendingKindSchema>;
type UsagePending = Static<typeof usagePendingSchema>;

/**
 * Advisory provider usage accounting for one AgentSystem.
 *
 * The module owns its bounded records in a module-owned table. The host
 * uses the database carried by the context; Agent Base supplies the durable
 * inference and turn identities used as record IDs.
 */
export class UsageModule implements AgentModule {
    readonly name = "usage";
    readonly migrations = [
        [
            "001-usage-records",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_usage_records (
                        record_id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL,
                        finished_at INTEGER NOT NULL,
                        kind TEXT NOT NULL,
                        record_json TEXT NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE INDEX IF NOT EXISTS happy_agent_usage_records_agent_time
                        ON happy_agent_usage_records (agent_id, finished_at, record_id)`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_usage_reset_receipts (
                        operation_id TEXT PRIMARY KEY,
                        created_at INTEGER NOT NULL,
                        receipt_json TEXT NOT NULL
                    )`,
                );
            },
        ],
        [
            "002-drop-usage-reset-receipts",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`DROP TABLE IF EXISTS happy_agent_usage_reset_receipts`,
                );
            },
        ],
    ] as const;
    readonly #clock: NonNullable<UsageModuleOptions["clock"]>;
    readonly #idFactory: NonNullable<UsageModuleOptions["idFactory"]>;
    readonly #listener: UsageModuleOptions["listener"];
    readonly #maxPageSize: number;
    readonly #maxGroups: number;
    readonly #maxOutputCharacters: number;
    readonly #agentTreeReader: UsageAgentTreeReader | undefined;
    readonly #agentTreeAuthorization: UsageAgentTreeAuthorization | undefined;
    readonly #onObserverError: UsageModuleOptions["onObserverError"];

    constructor(options: UsageModuleOptions) {
        const validated = validateOptions(options);
        this.#clock = validated.clock ?? (() => Date.now());
        this.#idFactory =
            validated.idFactory ??
            (() => {
                return globalThis.crypto.randomUUID();
            });
        this.#listener = validated.listener;
        this.#maxPageSize = validated.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxGroups = validated.maxGroups ?? DEFAULT_MAX_GROUPS;
        this.#maxOutputCharacters = validated.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        this.#agentTreeReader = validated.agentTreeReader;
        this.#agentTreeAuthorization = validated.agentTreeAuthorization;
        this.#onObserverError = validated.onObserverError;
    }

    /** Read one agent's bounded aggregate. */
    async read(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        this.#assertAgentAccess(ctx, agentId);
        if (!Value.Check(usageReadQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        const fullQuery = {
            agentId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.maxGroups === undefined ? {} : { maxGroups: query.maxGroups }),
        };
        if (!Value.Check(usageAggregateQuerySchema, fullQuery)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        return await this.aggregate(ctx, {
            ...fullQuery,
        });
    }

    /** Explicit alias for callers that prefer the per-agent name. */
    async readAgent(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.read(ctx, agentId, query);
    }

    /** Descriptive alias for host APIs that name the aggregate explicitly. */
    async readAgentUsage(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.readAgent(ctx, agentId, query);
    }

    /** Read one bounded raw page for a host that needs provider/model detail. */
    async readPage(ctx: Context, agentId: string, query: UsagePageQuery = {}): Promise<UsagePage> {
        this.#assertAgentAccess(ctx, agentId);
        if (!Value.Check(usagePageQuerySchema, query)) {
            throw new Error("Usage page query is invalid.");
        }
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Usage page limit cannot exceed ${this.#maxPageSize}.`);
        }
        const cursor = query.cursor ?? 0;
        const page = await new UsageDatabase().read(
            ctx,
            agentId,
            { cursor, limit },
            this.#maxPageSize,
        );
        assertUsagePage(page, agentId, cursor, limit);
        return cloneValue(page);
    }

    /** Read a bounded aggregate for one agent or the whole collection. */
    async aggregate(ctx: Context, query: UsageAggregateQuery = {}): Promise<UsageSummary> {
        if (!Value.Check(usageAggregateQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        this.#assertAgentAccess(ctx, query.agentId);
        const maxGroups = query.maxGroups ?? this.#maxGroups;
        if (maxGroups > this.#maxGroups) {
            throw new Error(`Usage group limit cannot exceed ${this.#maxGroups}.`);
        }
        const cursor = query.cursor ?? 0;
        const summary = await new UsageDatabase().aggregate(
            ctx,
            {
                ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
                cursor,
                maxGroups,
            },
            maxGroups,
        );
        assertUsageSummary(summary, query.agentId, cursor, maxGroups);
        return cloneValue(summary);
    }

    /** Explicit alias for collection readers. */
    async readAggregate(
        ctx: Context,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.aggregate(ctx, query);
    }

    /** Descriptive alias for host APIs that name the aggregate explicitly. */
    async readAggregateUsage(
        ctx: Context,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.readAggregate(ctx, query);
    }

    /**
     * Read a complete bounded subtree snapshot supplied by the host.  A
     * context with an owning agent requires the explicit authorization seam;
     * an unscoped host context is already outside model-facing access policy.
     */
    async readAgentTreeUsage(ctx: Context, agentId: string): Promise<UsageAgentTree> {
        assertAgentId(agentId);
        const owner = contextAgentId(ctx);
        if (owner !== undefined && owner !== agentId) {
            throw new Error("Usage access is limited to the current agent.");
        }
        const reader = this.#agentTreeReader;
        if (reader === undefined) {
            throw new Error("Usage agent tree is unavailable without host wiring.");
        }
        if (owner !== undefined) {
            const authorize = this.#agentTreeAuthorization;
            if (authorize === undefined) {
                throw new Error("Usage agent tree access is not authorized.");
            }
            const decision = authorize(ctx, agentId);
            const allowed = await resolveMaybePromise(
                decision,
                Type.Boolean(),
                "Usage agent tree authorization",
            );
            if (allowed !== true) {
                throw new Error("Usage agent tree access is not authorized.");
            }
        }
        const raw = reader(ctx, agentId);
        const tree = await resolveMaybePromise(
            raw,
            usageAgentTreeSchema,
            "Usage agent tree reader",
        );
        const detached = cloneValue(tree);
        assertUsageAgentTree(detached, agentId);
        return detached;
    }

    /** Alias retained for hosts that use a shorter tree-reader name. */
    async readAgentTree(ctx: Context, agentId: string): Promise<UsageAgentTree> {
        return await this.readAgentTreeUsage(ctx, agentId);
    }

    /** Reset one agent's usage. */
    async reset(ctx: Context, agentId: string): Promise<number> {
        this.#assertAgentAccess(ctx, agentId);
        return await this.#reset(ctx, agentId);
    }

    /** Descriptive alias for the per-agent reset operation. */
    async resetAgentUsage(ctx: Context, agentId: string): Promise<number> {
        return await this.reset(ctx, agentId);
    }

    /** Reset every agent's usage in one host transaction. */
    async resetAll(ctx: Context): Promise<number> {
        this.#assertAgentAccess(ctx, undefined);
        return await this.#reset(ctx, undefined);
    }

    /** Descriptive alias for the collection reset operation. */
    async resetAggregateUsage(ctx: Context): Promise<number> {
        return await this.resetAll(ctx);
    }

    /** Render a bounded subtree snapshot for a model-facing tool result. */
    formatAgentTreeUsageForModel(
        tree: UsageAgentTree,
        maxCharacters = this.#maxOutputCharacters,
    ): string {
        assertUsageAgentTree(tree);
        if (
            !Number.isInteger(maxCharacters) ||
            maxCharacters < 256 ||
            maxCharacters > this.#maxOutputCharacters
        ) {
            throw new Error("Usage output bound is invalid.");
        }
        const header = `Agent tree usage: ${tree.totalTokens} total tokens across ${tree.sessions.length} agents.`;
        const lines = [header];
        for (const session of tree.sessions) {
            const line = [
                session.agentId,
                session.relation,
                session.status,
                session.path,
                `${session.totalTokens} tokens`,
            ].join(" | ");
            if (lines.join("\n").length + 1 + line.length > maxCharacters) {
                lines.push(
                    `- Output capped at ${maxCharacters} characters; structured result contains ${tree.sessions.length} validated agents.`,
                );
                break;
            }
            lines.push(line);
        }
        const output = lines.join("\n");
        if (output.length <= maxCharacters) return output;
        return truncate(
            `Agent tree usage: ${tree.totalTokens} total tokens across ${tree.sessions.length} agents.`,
            maxCharacters,
        );
    }

    /**
     * Render a bounded model-facing summary.  Group rows are admitted one at
     * a time and the continuation cursor is computed from the last visible
     * row, so output truncation never skips an unseen group.
     */
    formatForModel(summary: UsageSummary, maxCharacters = this.#maxOutputCharacters): string {
        assertUsageSummary(summary, summary.agentId, summary.cursor, this.#maxGroups);
        if (
            !Number.isInteger(maxCharacters) ||
            maxCharacters < 256 ||
            maxCharacters > this.#maxOutputCharacters
        ) {
            throw new Error("Usage output bound is invalid.");
        }
        const scope = summary.agentId === undefined ? "all agents" : `agent ${summary.agentId}`;
        const displayScope = truncate(scope, 96);
        const lines = [
            `Usage for ${displayScope}:`,
            `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
            `- ${summary.inputTokens} input tokens, ${summary.outputTokens} output tokens (${summary.totalTokens} total)`,
            `- ${summary.totalDurationMs} ms total (${summary.inferenceDurationMs} ms inference, ${summary.turnDurationMs} ms turn)`,
            summary.currentContext === undefined
                ? "- Current context: unavailable (no provider measurement yet)."
                : `- Current context: ${summary.currentContext.contextTokens} tokens${
                      summary.currentContext.approximate ? " (approximate)" : ""
                  }.`,
        ];
        const visibleGroups: string[] = [];
        for (const [index, group] of summary.groups.entries()) {
            const groupCursor = summary.cursor + index;
            const line = formatGroup(group, groupCursor, maxCharacters);
            const footer =
                "- More groups are available; call get_usage with aggregate=true and cursor=";
            const nextCursor = groupCursor + 1;
            const reserve =
                index + 1 < summary.groups.length || summary.nextCursor !== undefined
                    ? `\n${footer}${nextCursor}.`
                    : "";
            const candidate = [...lines, ...visibleGroups, line].join("\n");
            if (candidate.length + reserve.length > maxCharacters) {
                break;
            }
            visibleGroups.push(line);
        }
        lines.push(...visibleGroups);
        const hiddenInPage = visibleGroups.length < summary.groups.length;
        const continuation = hiddenInPage
            ? summary.cursor + Math.max(1, visibleGroups.length)
            : summary.nextCursor;
        if (continuation !== undefined) {
            lines.push(
                `- More groups are available; call get_usage with aggregate=true and cursor=${continuation}.`,
            );
        }
        const output = lines.join("\n");
        if (output.length <= maxCharacters && !(hiddenInPage && visibleGroups.length === 0)) {
            return output;
        }
        /*
         * The header is bounded well below the minimum output size.  A
         * pathological attribution can still consume the budget; retain the
         * header and an explicit cursor rather than slicing a group row.
         */
        const cursor =
            continuation ??
            (summary.groups.length > 0
                ? summary.cursor + Math.max(1, visibleGroups.length)
                : undefined);
        const fallback =
            cursor === undefined
                ? lines.slice(0, 4).join("\n")
                : [
                      `Usage for ${displayScope}:`,
                      `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
                      ...(summary.groups[0] === undefined
                          ? []
                          : [formatCompactGroup(summary.groups[0], summary.cursor)]),
                      `- More groups are available; call get_usage with aggregate=true and cursor=${cursor}.`,
                  ].join("\n");
        if (fallback.length <= maxCharacters) return fallback;
        if (cursor === undefined) {
            const compactSummary = [
                `Usage for ${truncate(scope, 32)}:`,
                `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
            ].join("\n");
            return compactSummary.length <= maxCharacters ? compactSummary : "Usage";
        }
        const compactFooter = `- More groups are available; call get_usage with aggregate=true and cursor=${cursor ?? summary.cursor}.`;
        const compact = [
            `Usage for ${truncate(scope, 32)}:`,
            ...(summary.groups[0] === undefined
                ? []
                : [formatCompactGroup(summary.groups[0], summary.cursor, maxCharacters)]),
            compactFooter,
        ].join("\n");
        if (compact.length <= maxCharacters) return compact;
        return ["Usage:", `- group ${summary.cursor}`, compactFooter].join("\n");
    }

    async #beginObservation(
        ctx: Context,
        scope: AgentModuleScope,
        kind: UsagePendingKind,
    ): Promise<void> {
        try {
            const key = kind === "inference" ? INFERENCE_PENDING_KEY : TURN_PENDING_KEY;
            const pending: UsagePending = {
                startedAt: this.#now(),
            };
            await scope.runKV.write(ctx, key, cloneValue(pending));
        } catch (error: unknown) {
            await this.#reportObserverError(ctx, "begin", error);
        }
    }

    async #finishInference(
        ctx: Context,
        scope: AgentModuleScope,
        inference: AgentBaseInference,
    ): Promise<void> {
        await this.#finish(ctx, scope, "inference", async (startedAt, finishedAt, durationMs) => {
            if (inference.tokens === undefined) {
                throw new Error("Inference did not report provider token counts.");
            }
            assertUsageTokens(inference.tokens);
            const record: UsageInferenceRecord = {
                id: inference.inferenceId,
                agentId: scope.agent.id,
                provider: scope.agent.provider,
                kind: "inference",
                tokens: cloneValue(inference.tokens),
                startedAt,
                finishedAt,
                durationMs,
                ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                ...(scope.agent.effort === undefined ? {} : { effort: scope.agent.effort }),
                ...(scope.agent.tier === undefined ? {} : { tier: scope.agent.tier }),
                ...(inference.state === undefined ? {} : { state: inference.state }),
                ...(inference.errorMessage === undefined
                    ? {}
                    : { errorMessage: inference.errorMessage }),
            };
            assertUsageRecord(record);
            await this.#record(ctx, scope, record);
        });
    }

    async #finishTurn(ctx: Context, scope: AgentModuleScope, turn: AgentBaseTurn): Promise<void> {
        await this.#finish(ctx, scope, "turn", async (startedAt, finishedAt, durationMs) => {
            if (
                turn.contextTokens !== undefined &&
                (!Number.isInteger(turn.contextTokens) ||
                    turn.contextTokens < 0 ||
                    turn.contextTokens > MAX_USAGE_TOKEN_COUNT)
            ) {
                throw new Error("Turn context tokens are invalid.");
            }
            const record: UsageTurnRecord = {
                id: turn.turnId,
                agentId: scope.agent.id,
                provider: scope.agent.provider,
                kind: "turn",
                aborted: turn.aborted,
                startedAt,
                finishedAt,
                durationMs,
                ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                ...(scope.agent.effort === undefined ? {} : { effort: scope.agent.effort }),
                ...(scope.agent.tier === undefined ? {} : { tier: scope.agent.tier }),
                ...(turn.contextTokens === undefined ? {} : { contextTokens: turn.contextTokens }),
            };
            assertUsageRecord(record);
            await this.#record(ctx, scope, record);
        });
    }

    async #finish(
        ctx: Context,
        scope: AgentModuleScope,
        kind: UsagePendingKind,
        write: (startedAt: number, finishedAt: number, durationMs: number) => Promise<void>,
    ): Promise<void> {
        const key = kind === "inference" ? INFERENCE_PENDING_KEY : TURN_PENDING_KEY;
        try {
            const stored = await scope.runKV.read(ctx, key);
            const startedAt = stored === undefined ? this.#now() : assertPending(stored).startedAt;
            const finishedAt = this.#now();
            if (finishedAt < startedAt) {
                throw new Error("Usage clock moved backwards.");
            }
            const durationMs = finishedAt - startedAt;
            if (
                !Number.isInteger(durationMs) ||
                durationMs < 0 ||
                durationMs > MAX_USAGE_DURATION_MS
            ) {
                throw new Error("Usage duration is outside its configured bounds.");
            }
            await write(startedAt, finishedAt, durationMs);
            await scope.runKV.delete(ctx, key);
        } catch (error: unknown) {
            await this.#reportObserverError(ctx, `after_${kind}`, error);
            try {
                await scope.runKV.delete(ctx, key);
            } catch (cleanupError: unknown) {
                await this.#reportObserverError(ctx, `clear_${kind}`, cleanupError);
            }
        }
    }

    async #record(ctx: Context, scope: AgentModuleScope, record: UsageRecord): Promise<void> {
        assertUsageRecord(record);
        const detachedRecord = deepFreeze(cloneValue(record));
        await new UsageDatabase().record(ctx, detachedRecord);
        const event = cloneAndFreezeEvent({
            type: "usage_recorded",
            eventId: detachedRecord.id,
            at: detachedRecord.finishedAt,
            record: cloneValue(detachedRecord),
        });
        await this.#notifyTransactional(ctx, event);
        this.#registerPostCommit(ctx, event);
    }

    async #reset(ctx: Context, agentId: string | undefined): Promise<number> {
        if (agentId !== undefined) assertAgentId(agentId);
        const target: UsageResetTarget = agentId ?? null;
        const eventId = await this.#newId(ctx, target ?? "all-agents", "reset");
        return await ctx.inTx(async (txCtx) => {
            const removed = await new UsageDatabase().reset(txCtx, target);
            const event =
                removed > 0
                    ? cloneAndFreezeEvent({
                          type: "usage_reset",
                          eventId,
                          at: this.#now(),
                          agentId: target,
                          removed,
                      })
                    : undefined;
            if (event !== undefined) {
                await this.#notifyTransactional(txCtx, event);
                this.#registerPostCommit(txCtx, event);
            }
            return removed;
        });
    }

    #registerPostCommit(ctx: Context, event: UsageEvent): void {
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyTransactional(ctx: Context, event: UsageEvent): Promise<void> {
        const listener = this.#listener;
        if (listener?.onEventTransactional === undefined) return;
        await invokeVoid(listener.onEventTransactional(ctx, event), "Usage transactional listener");
    }

    async #notifyPostCommit(ctx: Context, event: UsageEvent): Promise<void> {
        const listener = this.#listener;
        if (listener?.onEvent === undefined) return;
        try {
            await invokeVoid(listener.onEvent(ctx, event), "Usage post-commit listener");
        } catch (error: unknown) {
            await this.#reportObserverError(ctx, "post_commit_listener", error);
        }
    }

    async #reportObserverError(ctx: Context, phase: string, error: unknown): Promise<void> {
        const boundedMessage = normalizeObserverError(error);
        const callback = this.#onObserverError;
        if (callback === undefined) return;
        try {
            await invokeVoid(
                callback(ctx, phase.slice(0, 64), boundedMessage),
                "Usage observer error handler",
            );
        } catch {
            // Optional reporting is deliberately non-fatal.
        }
    }

    async #newId(ctx: Context, agentId: string, kind: UsageFactoryKind): Promise<string> {
        const produced = this.#idFactory(ctx, agentId, kind);
        if (!Value.Check(usageFactoryResultSchema, produced)) {
            throw new Error("Usage ID factory returned an invalid result.");
        }
        const id =
            produced instanceof Promise
                ? await resolvePromise(produced, usageIdSchema, "Usage ID factory")
                : produced;
        if (!Value.Check(usageIdSchema, id)) {
            throw new Error("Usage ID factory returned an invalid ID.");
        }
        return id;
    }

    #now(): number {
        const now = this.#clock();
        if (!Value.Check(usageTimestampSchema, now)) {
            throw new Error("Usage clock must return a bounded non-negative integer.");
        }
        return now;
    }

    #assertAgentAccess(ctx: Context, requested: string | undefined): void {
        if (requested !== undefined) assertAgentId(requested);
        const owner = contextAgentId(ctx);
        if (owner !== undefined && owner !== requested) {
            throw new Error("Usage access is limited to the current agent.");
        }
        if (owner !== undefined && requested === undefined) {
            throw new Error("Usage collection access is not available to an agent context.");
        }
    }

    readonly #hooks: AgentModuleHooks = {
        /** The provider-neutral usage tool available to every agent. */
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            getUsageTool(this, scope.agent.id),
            getAgentTreeUsageTool(this, scope.agent.id),
        ],

        /** Persist the inference start time in Base's current transaction. */
        beforeInferenceTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            _inference: AgentBaseInferenceStart,
        ): Promise<void> => {
            await this.#beginObservation(ctx, scope, "inference");
        },

        /** Persist the turn start time in Base's current transaction. */
        beforeTurnTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            _turn: AgentBaseTurnStart,
        ): Promise<void> => {
            await this.#beginObservation(ctx, scope, "turn");
        },

        /** Record provider-measured tokens inside Base's inference completion transaction. */
        afterInferenceTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): Promise<void> => {
            await this.#finishInference(ctx, scope, inference);
        },

        /** Record turn timing inside Base's turn completion transaction. */
        afterTurnTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurn,
        ): Promise<void> => {
            await this.#finishTurn(ctx, scope, turn);
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

function validateOptions(options: unknown): UsageModuleOptions {
    if (typeof options !== "object" || options === null) {
        throw new Error("Usage module options contain unknown or invalid keys.");
    }
    const source = options as Record<string, unknown>;
    const view = {
        ...source,
        ...(source.listener === undefined
            ? {}
            : { listener: usageListenerMethodView(source.listener) }),
    };
    if (!Value.Check(usageModuleOptionsSchema, view)) {
        throw new Error("Usage module options contain unknown or invalid keys.");
    }
    return options as UsageModuleOptions;
}

function usageListenerMethodView(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const source = value as Record<string, unknown>;
    if (isPlainObject(value)) return value;
    return {
        ...(source.onEventTransactional === undefined
            ? {}
            : { onEventTransactional: source.onEventTransactional }),
        ...(source.onEvent === undefined ? {} : { onEvent: source.onEvent }),
    };
}

function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertPending(value: unknown): UsagePending {
    if (!Value.Check(usagePendingSchema, value)) {
        throw new Error("Stored usage observation is invalid.");
    }
    return value as UsagePending;
}

function assertAgentId(agentId: string): void {
    if (!Value.Check(usageAgentIdSchema, agentId)) {
        throw new Error("Usage agent ID is invalid.");
    }
}

function assertUsageAgentTree(
    value: unknown,
    expectedRootAgentId?: string,
): asserts value is UsageAgentTree {
    if (!Value.Check(usageAgentTreeSchema, value)) {
        throw new Error("Usage agent tree is invalid.");
    }
    const tree = value as UsageAgentTree;
    if (tree.sessions.length === 0 || tree.sessions.length > MAX_USAGE_TREE_SESSIONS) {
        throw new Error("Usage agent tree is outside its configured bounds.");
    }
    const byAgentId = new Map<string, UsageAgentTree["sessions"][number]>();
    for (const session of tree.sessions) {
        if (byAgentId.has(session.agentId)) {
            throw new Error("Usage agent tree contains duplicate agent IDs.");
        }
        if (!session.path.startsWith("/") || session.path.length > MAX_USAGE_TREE_PATH_LENGTH) {
            throw new Error("Usage agent tree contains an invalid canonical path.");
        }
        byAgentId.set(session.agentId, session);
    }
    const roots = tree.sessions.filter((session) => session.relation === "root");
    if (roots.length !== 1 || roots[0]!.parentAgentId !== undefined) {
        throw new Error("Usage agent tree must contain exactly one parentless root.");
    }
    const root = roots[0]!;
    if (expectedRootAgentId !== undefined && root.agentId !== expectedRootAgentId) {
        throw new Error("Usage agent tree is rooted at the wrong agent.");
    }
    for (const session of tree.sessions) {
        if (session.relation === "root") continue;
        const parentAgentId = session.parentAgentId;
        if (parentAgentId === undefined || !byAgentId.has(parentAgentId)) {
            throw new Error("Usage agent tree contains an unavailable parent.");
        }
        if (parentAgentId === session.agentId) {
            throw new Error("Usage agent tree contains a self-parenting agent.");
        }
        const visited = new Set<string>();
        let current: UsageAgentTree["sessions"][number] | undefined = session;
        while (current !== undefined && current.relation !== "root") {
            if (visited.has(current.agentId)) {
                throw new Error("Usage agent tree contains a parent cycle.");
            }
            visited.add(current.agentId);
            current =
                current.parentAgentId === undefined
                    ? undefined
                    : byAgentId.get(current.parentAgentId);
        }
        if (current === undefined) {
            throw new Error("Usage agent tree does not connect every agent to its root.");
        }
    }
    const totalTokens = tree.sessions.reduce((sum, session) => sum + session.totalTokens, 0);
    if (totalTokens !== tree.totalTokens) {
        throw new Error("Usage agent tree total tokens are inconsistent.");
    }
}

function assertUsagePage(page: UsagePage, agentId: string, cursor: number, limit: number): void {
    if (page.agentId !== agentId || page.cursor !== cursor) {
        throw new Error("Usage store returned a page for the wrong agent or cursor.");
    }
    if (
        page.records.length > limit ||
        page.totalRecords > MAX_USAGE_RECORDS ||
        page.cursor > page.totalRecords
    ) {
        throw new Error("Usage store returned a page outside its configured bounds.");
    }
    if (page.records.length > 0 && page.cursor >= page.totalRecords) {
        throw new Error("Usage store returned records beyond its total.");
    }
    const ids = new Set<string>();
    for (const record of page.records) {
        assertUsageRecord(record);
        if (record.agentId !== agentId || ids.has(record.id)) {
            throw new Error("Usage store returned invalid or duplicate page records.");
        }
        ids.add(record.id);
    }
    if (page.nextCursor !== undefined) {
        if (
            page.records.length === 0 ||
            page.nextCursor !== page.cursor + page.records.length ||
            page.nextCursor > page.totalRecords
        ) {
            throw new Error("Usage store returned a non-progressing or skipping record cursor.");
        }
    } else if (page.cursor + page.records.length < page.totalRecords) {
        throw new Error("Usage store omitted a record continuation cursor.");
    }
}

function assertUsageSummary(
    summary: UsageSummary,
    expectedAgentId: string | undefined,
    cursor: number,
    maxGroups: number,
): void {
    if (!Value.Check(usageSummarySchema, summary)) {
        throw new Error("Usage store returned an invalid summary.");
    }
    if (
        summary.agentId !== expectedAgentId ||
        summary.cursor !== cursor ||
        summary.groups.length > maxGroups ||
        summary.totalGroups < summary.groups.length ||
        summary.cursor > summary.totalGroups ||
        (summary.groups.length > 0 && summary.cursor >= summary.totalGroups) ||
        summary.inferenceCount + summary.turnCount > MAX_USAGE_RECORDS
    ) {
        throw new Error("Usage store returned a summary for the wrong scope or page.");
    }
    if (summary.totalTokens !== summary.inputTokens + summary.outputTokens) {
        throw new Error("Usage summary token totals are inconsistent.");
    }
    if (summary.totalDurationMs !== summary.inferenceDurationMs + summary.turnDurationMs) {
        throw new Error("Usage summary duration totals are inconsistent.");
    }
    const keys = new Set<string>();
    for (const group of summary.groups) {
        const key = groupKey(group);
        if (keys.has(key)) {
            throw new Error("Usage store returned duplicate aggregate groups.");
        }
        keys.add(key);
        if (group.inferenceCount + group.turnCount > MAX_USAGE_RECORDS) {
            throw new Error("Usage aggregate counts exceed the configured record bound.");
        }
        if (group.totalTokens !== group.inputTokens + group.outputTokens) {
            throw new Error("Usage aggregate token totals are inconsistent.");
        }
        if (group.totalDurationMs !== group.inferenceDurationMs + group.turnDurationMs) {
            throw new Error("Usage aggregate duration totals are inconsistent.");
        }
    }
    if (summary.nextCursor !== undefined) {
        if (
            summary.groups.length === 0 ||
            summary.nextCursor !== summary.cursor + summary.groups.length ||
            summary.nextCursor > summary.totalGroups
        ) {
            throw new Error("Usage store returned a non-progressing or skipping aggregate cursor.");
        }
    } else if (summary.cursor + summary.groups.length < summary.totalGroups) {
        throw new Error("Usage store omitted an aggregate continuation cursor.");
    }
}

function groupKey(group: UsageSummary["groups"][number]): string {
    return JSON.stringify([group.provider, group.model, group.effort, group.tier]);
}

function formatGroup(
    group: UsageSummary["groups"][number],
    cursor: number,
    maxCharacters: number,
): string {
    const attribution = groupIdentity(group);
    const complete = `- group ${cursor} ${attribution}: ${group.totalTokens} tokens, ${group.totalDurationMs} ms`;
    if (complete.length <= maxCharacters) return complete;
    const compact = `- group ${cursor} id=${opaqueGroupId(group)}: ${group.totalTokens} tokens`;
    if (compact.length <= maxCharacters) return compact;
    return `- group ${cursor} id=${opaqueGroupId(group)}`;
}

function formatCompactGroup(
    group: UsageSummary["groups"][number],
    cursor: number,
    maxCharacters = 96,
): string {
    const attribution = groupIdentity(group);
    const line = `- group ${cursor} ${attribution}`;
    if (line.length <= maxCharacters) return line;
    return `- group ${cursor} id=${opaqueGroupId(group)}`;
}

function groupIdentity(group: UsageSummary["groups"][number]): string {
    return [
        group.provider,
        ...(group.model === undefined ? [] : [group.model]),
        ...(group.effort === undefined ? [] : [`effort=${group.effort}`]),
        ...(group.tier === undefined ? [] : [`tier=${group.tier}`]),
    ].join("/");
}

function opaqueGroupId(group: UsageSummary["groups"][number]): string {
    const identity = JSON.stringify([
        group.provider,
        group.model ?? null,
        group.effort ?? null,
        group.tier ?? null,
    ]);
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < identity.length; index++) {
        hash ^= BigInt(identity.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `g-${hash.toString(16).padStart(16, "0")}`;
}

function truncate(value: string, maxCharacters: number): string {
    if (value.length <= maxCharacters) return value;
    if (maxCharacters <= 1) return value.slice(0, maxCharacters);
    return `${value.slice(0, maxCharacters - 1)}…`;
}

function cloneAndFreezeEvent(event: UsageEvent): UsageEvent {
    if (!Value.Check(usageEventSchema, event)) {
        throw new Error("Usage module created an invalid event.");
    }
    const cloned = cloneValue(event);
    if (!Value.Check(usageEventSchema, cloned)) {
        throw new Error("Usage module created an invalid detached event.");
    }
    return deepFreeze(cloned);
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

async function resolvePromise<T>(value: unknown, schema: TSchema, operation: string): Promise<T> {
    if (!Value.Check(Type.Promise(Type.Void()), value)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    const resolved = await (value as Promise<unknown>);
    if (!Value.Check(schema, resolved)) {
        throw new Error(`${operation} returned an invalid result.`);
    }
    return resolved as T;
}

async function resolveMaybePromise<T>(
    value: unknown,
    schema: TSchema,
    operation: string,
): Promise<T> {
    if (Value.Check(Type.Promise(Type.Void()), value)) {
        return await resolvePromise(value, schema, operation);
    }
    if (!Value.Check(schema, value)) {
        throw new Error(`${operation} returned an invalid result.`);
    }
    return value as T;
}

async function invokeVoid(value: unknown, operation: string): Promise<void> {
    if (!Value.Check(usageVoidOrPromiseVoidSchema, value)) {
        throw new Error(`${operation} must return void or Promise<void>.`);
    }
    if (value === undefined) return;
    const resolved = await resolvePromise(value, Type.Void(), operation);
    if (resolved !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}

function normalizeObserverError(error: unknown): string {
    let message: unknown;
    try {
        if (error instanceof Error) {
            try {
                message = error.message;
            } catch {
                // Fall through to the safer string conversion.
            }
        }
        if (typeof message !== "string") {
            try {
                message = String(error);
            } catch {
                // Keep the bounded fallback below.
            }
        }
    } catch {
        // Hostile values can even throw while being inspected.
    }
    if (typeof message !== "string" || message.length === 0) {
        return "Unknown usage observer error.";
    }
    return message.slice(0, DEFAULT_MAX_OBSERVER_ERROR_LENGTH);
}
