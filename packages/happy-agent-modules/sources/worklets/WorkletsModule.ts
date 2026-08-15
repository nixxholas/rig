import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    MAX_WORKLET_DETAIL_CHARACTERS,
    MAX_WORKLET_DETAIL_PAGE_SIZE,
    MAX_WORKLET_INVOCATION_BYTES,
    MAX_WORKLET_JSON_DEPTH,
    MAX_WORKLET_JSON_ITEMS,
    MAX_WORKLET_JSON_KEY_LENGTH,
    MAX_WORKLET_JSON_PROPERTIES,
    MAX_WORKLET_JSON_STRING_LENGTH,
    MAX_WORKLET_LIST_SIZE,
    MAX_WORKLET_LOG_CHARACTERS,
    MAX_WORKLET_LOG_LINE_LENGTH,
    MAX_WORKLET_LOG_LINES,
    MAX_WORKLET_OUTPUT_CHARACTERS,
    MAX_WORKLET_VERSIONS,
    workletAgentIdSchema,
    workletChangeDescriptionSchema,
    workletDetailQuerySchema,
    workletDetailSchema,
    workletInstallInputSchema,
    workletInvocationInputSchema,
    workletJsonValueSchema,
    workletListQuerySchema,
    workletLogQuerySchema,
    workletNameSchema,
    workletRevertInputSchema,
    workletSchema,
    workletSourceRefSchema,
    workletStatusSchema,
    workletTimestampSchema,
    workletUpdateInputSchema,
    type Worklet,
    type WorkletDetail,
    type WorkletDetailPage,
    type WorkletDetailQuery,
    type WorkletInstallInput,
    type WorkletInvocationInput,
    type WorkletInvocationResult,
    type WorkletListPage,
    type WorkletListQuery,
    type WorkletLogPage,
    type WorkletLogQuery,
    type WorkletRevertInput,
    type WorkletStatus,
    type WorkletUpdateInput,
    type WorkletVersion,
} from "./Worklet.js";
import {
    MAX_WORKLET_EVENT_ID_LENGTH,
    workletEventIdSchema,
    workletEventSchema,
    workletModuleListenerSchema,
    type WorkletEvent,
    type WorkletModuleListener,
} from "./WorkletEvent.js";
import {
    assertWorklet,
    assertWorkletDetailPage,
    assertWorkletInvocationResult,
    assertWorkletListPage,
    assertWorkletListPageShape,
    assertWorkletLogPage,
    assertWorkletMutation,
    assertWorkletRuntimeInvocationRequest,
    assertWorkletRuntimeLogQuery,
    assertWorkletStage,
    assertWorkletStatus,
    assertWorkletTransactionChange,
    workletRuntimeSchema,
    workletStageInputSchema,
    workletStageSchema,
    type WorkletCatalogInstallInput,
    type WorkletCatalogMutationResult,
    type WorkletCatalogRevertInput,
    type WorkletCatalogUpdateInput,
    type WorkletRuntime,
    type WorkletRuntimeInvocationRequest,
    type WorkletRuntimeLogQuery,
    type WorkletStage,
    type WorkletTransactionChange,
} from "./WorkletStore.js";
import {
    WORKLETS_MIGRATION_KEY,
    WORKLETS_DROP_REPLAY_EVIDENCE_MIGRATION_KEY,
    WORKLET_PROOFS_TABLE,
    WORKLET_RECEIPTS_TABLE,
    WORKLET_TABLE,
    createWorkletDatabase,
    type WorkletDatabase,
} from "./WorkletDatabase.js";
import { getWorkletsDirectory } from "./getWorkletsDirectory.js";
import { WorkletInstaller } from "./WorkletInstaller.js";
import { getWorkletTool } from "./tools/get_worklet.js";
import { installWorkletTool } from "./tools/install_worklet.js";
import { invokeWorkletOperationTool } from "./tools/invoke_worklet_operation.js";
import { listWorkletsTool } from "./tools/list_worklets.js";
import { readWorkletLogsTool } from "./tools/read_worklet_logs.js";
import { removeWorkletTool } from "./tools/remove_worklet.js";
import { revertWorkletTool } from "./tools/revert_worklet.js";
import { statusWorkletTool } from "./tools/get_worklet_status.js";
import { updateWorkletTool } from "./tools/update_worklet.js";

const opaqueContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);
const asyncIdSchema = Type.Union([
    workletAgentIdSchema,
    Type.Promise(workletAgentIdSchema),
]);
const asyncVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

export const workletAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("install"),
    Type.Literal("update"),
    Type.Literal("revert"),
    Type.Literal("remove"),
    Type.Literal("status"),
    Type.Literal("logs"),
    Type.Literal("invoke"),
]);

export type WorkletAuthorizationAction = Static<
    typeof workletAuthorizationActionSchema
>;

/**
 * Worklets are installation-global. The optional host policy can restrict
 * cross-agent access, while the no-policy default leaves every worklet
 * callable by every agent.
 */
export const workletAuthorizationSchema = Type.Function(
    [
        opaqueContextSchema,
        workletAgentIdSchema,
        workletAgentIdSchema,
        workletAuthorizationActionSchema,
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);

export type WorkletAuthorization = Static<typeof workletAuthorizationSchema>;

export const workletModuleOptionsSchema = Type.Object(
    {
        runtime: workletRuntimeSchema,
        /**
         * Absolute root the `<name>/{favicon.png,Data,v1,...}` layout is written
         * under. Defaults to the user-visible worklets folder.
         */
        installRoot: Type.Optional(Type.String({ minLength: 1 })),
        authorization: Type.Optional(workletAuthorizationSchema),
        idFactory: Type.Optional(
            Type.Function([opaqueContextSchema, workletAgentIdSchema], asyncIdSchema),
        ),
        eventIdFactory: Type.Optional(
            Type.Function(
                [opaqueContextSchema, workletAgentIdSchema],
                Type.Union([
                    Type.String({
                        minLength: 1,
                        maxLength: MAX_WORKLET_EVENT_ID_LENGTH,
                    }),
                    Type.Promise(
                        Type.String({
                            minLength: 1,
                            maxLength: MAX_WORKLET_EVENT_ID_LENGTH,
                        }),
                    ),
                ]),
            ),
        ),
        clock: Type.Optional(Type.Function([], workletTimestampSchema)),
        listener: Type.Optional(workletModuleListenerSchema),
        maxPageSize: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LIST_SIZE }),
        ),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: MAX_WORKLET_OUTPUT_CHARACTERS }),
        ),
        maxLogLines: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LOG_LINES }),
        ),
        maxLogLineCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LOG_LINE_LENGTH }),
        ),
        maxLogCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LOG_CHARACTERS }),
        ),
        maxArgumentDepth: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_JSON_DEPTH }),
        ),
        maxResultDepth: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_JSON_DEPTH }),
        ),
        maxInvocationBytes: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_INVOCATION_BYTES }),
        ),
        onPostCommitError: Type.Optional(
            Type.Function(
                [opaqueContextSchema, workletEventSchema, Type.Unknown()],
                asyncVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkletModuleOptions = Static<typeof workletModuleOptionsSchema>;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;
const DEFAULT_LOG_LINES = 200;
const DEFAULT_LOG_LINE_CHARACTERS = 4_000;
const DEFAULT_LOG_CHARACTERS = 50_000;
const DEFAULT_ARGUMENT_DEPTH = MAX_WORKLET_JSON_DEPTH;
const DEFAULT_RESULT_DEPTH = MAX_WORKLET_JSON_DEPTH;
const DEFAULT_INVOCATION_BYTES = MAX_WORKLET_INVOCATION_BYTES;

const workletOperationCommonFields = {
    agentId: workletAgentIdSchema,
    operationId: workletAgentIdSchema,
    name: workletNameSchema,
};

const workletOperationSchema = Type.Union([
    Type.Object(
        {
            ...workletOperationCommonFields,
            kind: Type.Literal("install"),
            sourceRef: workletSourceRefSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletOperationCommonFields,
            kind: Type.Literal("update"),
            sourceRef: workletSourceRefSchema,
            changeDescription: workletChangeDescriptionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletOperationCommonFields,
            kind: Type.Literal("revert"),
            version: Type.Integer({ minimum: 1, maximum: MAX_WORKLET_VERSIONS }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletOperationCommonFields,
            kind: Type.Literal("remove"),
        },
        { additionalProperties: false },
    ),
]);

type WorkletOperation = Static<typeof workletOperationSchema>;
type WorkletOperationRequest =
    | Omit<Extract<WorkletOperation, { kind: "install" }>, "agentId" | "operationId">
    | Omit<Extract<WorkletOperation, { kind: "update" }>, "agentId" | "operationId">
    | Omit<Extract<WorkletOperation, { kind: "revert" }>, "agentId" | "operationId">
    | Omit<Extract<WorkletOperation, { kind: "remove" }>, "agentId" | "operationId">;

type WorkletCompletion = (ctx: Context, worklet: Worklet) => Promise<void>;

type ModuleChange = WorkletTransactionChange;

type StageRegistration = {
    readonly rollbackNow: (ctx: Context) => Promise<void>;
    readonly markCommitted: () => void;
};

/** Coordinates module-owned worklet state with the external runtime. */
export class WorkletsModule implements AgentModule {
    readonly name = "worklets";

    readonly #catalog: WorkletDatabase;
    readonly #runtime: WorkletRuntime;
    readonly #installer: WorkletInstaller;
    readonly #authorization: WorkletAuthorization | undefined;
    readonly #idFactory: NonNullable<WorkletModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<WorkletModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<WorkletModuleOptions["clock"]>;
    readonly #listener: WorkletModuleListener | undefined;
    readonly #optionsOwner: WorkletModuleOptions;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #maxLogLines: number;
    readonly #maxLogLineCharacters: number;
    readonly #maxLogCharacters: number;
    readonly #maxArgumentDepth: number;
    readonly #maxResultDepth: number;
    readonly #maxInvocationBytes: number;
    readonly #onPostCommitError: WorkletModuleOptions["onPostCommitError"];

    readonly migrations: readonly AgentModuleMigration[] = [
        [
            WORKLETS_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKLET_TABLE)} (
                        name TEXT NOT NULL PRIMARY KEY,
                        worklet_json TEXT NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKLET_RECEIPTS_TABLE)} (
                        operation_id TEXT NOT NULL PRIMARY KEY,
                        value_json TEXT NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKLET_PROOFS_TABLE)} (
                        operation_id TEXT NOT NULL PRIMARY KEY,
                        value_json TEXT NOT NULL
                    )`,
                );
            },
        ],
        [
            WORKLETS_DROP_REPLAY_EVIDENCE_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`DROP TABLE IF EXISTS ${sql.raw(WORKLET_RECEIPTS_TABLE)}`,
                );
                await agentDatabaseRun(
                    database as AgentDatabase,
                    sql`DROP TABLE IF EXISTS ${sql.raw(WORKLET_PROOFS_TABLE)}`,
                );
            },
        ],
    ];

    constructor(options: WorkletModuleOptions) {
        assertWorkletModuleOptions(options);
        this.#catalog = createWorkletDatabase();
        this.#optionsOwner = options;
        this.#runtime = options.runtime;
        this.#installer = new WorkletInstaller({
            installRoot: options.installRoot ?? getWorkletsDirectory(),
        });
        this.#authorization = options.authorization;
        this.#idFactory =
            options.idFactory ??
            ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID());
        this.#eventIdFactory =
            options.eventIdFactory ??
            ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#listener = options.listener;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters =
            options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#maxLogLines = options.maxLogLines ?? DEFAULT_LOG_LINES;
        this.#maxLogLineCharacters =
            options.maxLogLineCharacters ?? DEFAULT_LOG_LINE_CHARACTERS;
        this.#maxLogCharacters = options.maxLogCharacters ?? DEFAULT_LOG_CHARACTERS;
        this.#maxArgumentDepth = options.maxArgumentDepth ?? DEFAULT_ARGUMENT_DEPTH;
        this.#maxResultDepth = options.maxResultDepth ?? DEFAULT_RESULT_DEPTH;
        this.#maxInvocationBytes =
            options.maxInvocationBytes ?? DEFAULT_INVOCATION_BYTES;
        this.#onPostCommitError = options.onPostCommitError;
    }

    readonly tools = (
        _ctx: Context,
        scope: AgentModuleScope,
    ): readonly AnyAgentTool[] => [
        installWorkletTool(this, scope.agent.id),
        listWorkletsTool(this, scope.agent.id),
        getWorkletTool(this, scope.agent.id),
        updateWorkletTool(this, scope.agent.id),
        revertWorkletTool(this, scope.agent.id),
        removeWorkletTool(this, scope.agent.id),
        statusWorkletTool(this, scope.agent.id),
        readWorkletLogsTool(this, scope.agent.id),
        invokeWorkletOperationTool(this, scope.agent.id),
    ];

    async install(
        ctx: Context,
        agentId: string,
        input: WorkletInstallInput,
    ): Promise<Worklet> {
        this.#assertAgentId(agentId);
        this.#assertInput(workletInstallInputSchema, input, "worklet install");
        const normalized = { name: input.name, sourceRef: input.sourceRef };
        const operation = await this.#operation(
            ctx,
            agentId,
            { kind: "install", ...normalized },
            INSTALL_OPERATION_KEY,
            input.operationId,
            fingerprint({ agentId, operation: "install", ...normalized }),
        );
        const result = await this.#runTransaction(ctx, "install", async (txCtx) => {
            const replay = await this.#readReplay(txCtx, operation);
            if (replay !== undefined) return { result: replay };

            const before = await this.#getCatalog(txCtx, input.name);
            if (before !== undefined) {
                await this.#authorize(txCtx, agentId, before.ownerAgentId, "install");
                throw new Error(`Worklet "${input.name}" already exists.`);
            }

            let stage: WorkletStage | undefined;
            try {
                await this.#reconcileFilesystem(txCtx, input.name, before);
                stage = await this.#stage(txCtx, {
                    name: input.name,
                    ownerAgentId: agentId,
                    version: 1,
                    sourceRef: input.sourceRef,
                    operationId: operation.operationId,
                    reuseExisting: false,
                });
                await this.#commitStage(txCtx, stage);
                const stageRegistration = await this.#registerStageRollback(txCtx, stage);
                const createdAt = this.#now();
                const raw = await this.#catalogInstall(txCtx, {
                    name: input.name,
                    ownerAgentId: agentId,
                    initialVersion: {
                        version: 1,
                        sourceRef: stage.sourceRef,
                        changeDescription: "Initial install",
                        operations: stage.operations,
                        createdAt,
                        operationId: operation.operationId,
                    },
                    operationId: operation.operationId,
                });
                const after = await this.#getCatalog(txCtx, input.name);
                if (after === undefined) {
                    throw new Error("Worklet catalog did not persist the installed worklet.");
                }
                this.#assertMutation(raw, operation, before, after, {
                    name: input.name,
                    targetVersion: 1,
                    createdAt,
                    stage,
                });
                const proof = this.#proof(operation, before, after, raw);
                await this.#writeEvidence(txCtx, operation, proof, raw);
                const event = await this.#newEvent(
                    txCtx,
                    agentId,
                    { type: "worklet_installed", worklet: after },
                );
                await this.#observeTransactional(txCtx, event);
                await this.#registerStagePostCommit(
                    txCtx,
                    stage,
                    event,
                    stageRegistration,
                );
                return { result: raw, event };
            } catch (error: unknown) {
                if (stage !== undefined) await this.#rollbackStage(txCtx, stage);
                throw error;
            }
        });
        if (result.operation !== "install") {
            throw new Error("Worklet install returned the wrong operation.");
        }
        return structuredClone(result.worklet);
    }

    async listPage(
        ctx: Context,
        agentId: string,
        query: WorkletListQuery = {},
    ): Promise<WorkletListPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(workletListQuerySchema, query, "worklet list query");
        const requested = query.limit ?? this.#maxPageSize;
        if (requested > this.#maxPageSize) {
            throw new Error(`Worklet list limit cannot exceed ${this.#maxPageSize}.`);
        }
        let limit = requested;
        for (let attempt = 0; attempt < requested; attempt += 1) {
            const page = await this.#listCatalog(ctx, {
                limit,
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            });
            limit = page.limit;
            try {
                this.#assertListPage(page, limit, query.cursor);
            } catch (error: unknown) {
                if (
                    page.worklets.length > 1 &&
                    error instanceof Error &&
                    error.message.includes("aggregate byte bound")
                ) {
                    limit = Math.max(1, Math.min(limit - 1, page.worklets.length - 1));
                    continue;
                }
                throw error;
            }
            for (const worklet of page.worklets) {
                await this.#authorize(ctx, agentId, worklet.ownerAgentId, "list");
            }
            if (this.formatPageForModel(page).length <= this.#maxOutputCharacters) {
                return structuredClone(page);
            }
            if (page.worklets.length <= 1) {
                throw new Error(
                    "Worklet list output cannot fit a complete identity and cursor.",
                );
            }
            limit = Math.max(1, Math.min(limit - 1, page.worklets.length - 1));
        }
        throw new Error("Worklet list could not make output-aware progress.");
    }

    async list(
        ctx: Context,
        agentId: string,
        query: WorkletListQuery = {},
    ): Promise<readonly Worklet[]> {
        return (await this.listPage(ctx, agentId, query)).worklets;
    }

    async get(
        ctx: Context,
        agentId: string,
        name: string,
    ): Promise<WorkletDetail | undefined> {
        this.#assertAgentId(agentId);
        this.#assertName(name);
        const worklet = await this.#getCatalog(ctx, name);
        if (worklet === undefined) return undefined;
        await this.#authorize(ctx, agentId, worklet.ownerAgentId, "get");
        const status = await this.#runtimeStatus(ctx, name);
        return this.#detail(worklet, status);
    }

    async getPage(
        ctx: Context,
        agentId: string,
        name: string,
        query: WorkletDetailQuery = {},
    ): Promise<WorkletDetailPage> {
        this.#assertAgentId(agentId);
        this.#assertName(name);
        this.#assertInput(workletDetailQuerySchema, query, "worklet detail query");
        const detail = await this.get(ctx, agentId, name);
        if (detail === undefined) return { worklet: null };

        const complete = this.#detailText(detail);
        const cursor = query.cursor ?? 0;
        let limit = query.limit ?? Math.min(MAX_WORKLET_DETAIL_PAGE_SIZE, this.#maxOutputCharacters);
        limit = Math.min(limit, MAX_WORKLET_DETAIL_PAGE_SIZE);
        for (;;) {
            const slice = complete.slice(cursor, cursor + limit);
            const candidate: WorkletDetailPage = {
                worklet: structuredClone(detail),
                detail: slice,
                cursor,
                limit,
                total: complete.length,
                ...(cursor > 0
                    ? {
                          previousCursor: Math.min(
                              complete.length,
                              Math.max(0, cursor - limit),
                          ),
                      }
                    : {}),
                ...(cursor + slice.length < complete.length
                    ? { nextCursor: cursor + slice.length }
                    : {}),
            };
            try {
                this.formatDetailPageForModel(candidate);
                return candidate;
            } catch {
                if (slice.length <= 1 || limit <= 1) {
                    throw new Error(
                        "Worklet detail output cannot fit a complete identity and cursor.",
                    );
                }
                limit = Math.max(1, Math.floor(limit / 2));
            }
        }
    }

    async update(
        ctx: Context,
        agentId: string,
        name: string,
        input: WorkletUpdateInput,
    ): Promise<Worklet> {
        this.#assertAgentId(agentId);
        this.#assertName(name);
        this.#assertInput(workletUpdateInputSchema, input, "worklet update");
        const normalized = {
            name,
            sourceRef: input.sourceRef,
            changeDescription: input.changeDescription,
        };
        const operation = await this.#operation(
            ctx,
            agentId,
            { kind: "update", ...normalized },
            UPDATE_OPERATION_KEY,
            input.operationId,
            fingerprint({ agentId, operation: "update", ...normalized }),
        );
        const result = await this.#runTransaction(ctx, "update", async (txCtx) => {
            const replay = await this.#readReplay(txCtx, operation);
            if (replay !== undefined) return { result: replay };
            const before = await this.#getCatalog(txCtx, name);
            if (before === undefined) throw new Error(`Worklet "${name}" was not found.`);
            await this.#authorize(txCtx, agentId, before.ownerAgentId, "update");
            const targetVersion = before.versions.length + 1;
            if (targetVersion > MAX_WORKLET_VERSIONS) {
                throw new Error("Worklet has reached its maximum version count.");
            }
            let stage: WorkletStage | undefined;
            try {
                await this.#reconcileFilesystem(txCtx, name, before);
                stage = await this.#stage(txCtx, {
                    name,
                    ownerAgentId: before.ownerAgentId,
                    version: targetVersion,
                    sourceRef: input.sourceRef,
                    operationId: operation.operationId,
                    reuseExisting: false,
                });
                await this.#commitStage(txCtx, stage);
                const stageRegistration = await this.#registerStageRollback(txCtx, stage);
                const createdAt = this.#now();
                const raw = await this.#catalogUpdate(txCtx, name, {
                    version: targetVersion,
                    sourceRef: stage.sourceRef,
                    changeDescription: input.changeDescription,
                    operations: stage.operations,
                    createdAt,
                    operationId: operation.operationId,
                });
                const after = await this.#getCatalog(txCtx, name);
                if (after === undefined) {
                    throw new Error("Worklet catalog removed the worklet during update.");
                }
                this.#assertMutation(raw, operation, before, after, {
                    name,
                    targetVersion,
                    changeDescription: input.changeDescription,
                    createdAt,
                    stage,
                });
                const proof = this.#proof(operation, before, after, raw);
                await this.#writeEvidence(txCtx, operation, proof, raw);
                const event = await this.#newEvent(
                    txCtx,
                    agentId,
                    { type: "worklet_updated", worklet: after },
                );
                await this.#observeTransactional(txCtx, event);
                await this.#registerStagePostCommit(
                    txCtx,
                    stage,
                    event,
                    stageRegistration,
                );
                return { result: raw, event };
            } catch (error: unknown) {
                if (stage !== undefined) await this.#rollbackStage(txCtx, stage);
                throw error;
            }
        });
        if (result.operation !== "update") {
            throw new Error("Worklet update returned the wrong operation.");
        }
        return structuredClone(result.worklet);
    }

    async revert(
        ctx: Context,
        agentId: string,
        name: string,
        input: WorkletRevertInput,
    ): Promise<Worklet> {
        this.#assertAgentId(agentId);
        this.#assertName(name);
        this.#assertInput(workletRevertInputSchema, input, "worklet revert");
        const operation = await this.#operation(
            ctx,
            agentId,
            { kind: "revert", name, version: input.version },
            REVERT_OPERATION_KEY,
            input.operationId,
            fingerprint({
                agentId,
                operation: "revert",
                name,
                version: input.version,
            }),
        );
        const result = await this.#runTransaction(ctx, "revert", async (txCtx) => {
            const replay = await this.#readReplay(txCtx, operation);
            if (replay !== undefined) return { result: replay };
            const before = await this.#getCatalog(txCtx, name);
            if (before === undefined) throw new Error(`Worklet "${name}" was not found.`);
            await this.#authorize(txCtx, agentId, before.ownerAgentId, "revert");
            const target = before.versions.find(
                (version) => version.version === input.version,
            );
            if (target === undefined) {
                throw new Error(`Worklet version ${input.version} does not exist.`);
            }
            let stage: WorkletStage | undefined;
            try {
                await this.#reconcileFilesystem(txCtx, name, before);
                stage = await this.#stage(txCtx, {
                    name,
                    ownerAgentId: before.ownerAgentId,
                    version: input.version,
                    sourceRef: target.sourceRef,
                    operationId: operation.operationId,
                    reuseExisting: true,
                });
                await this.#commitStage(txCtx, stage);
                const stageRegistration = await this.#registerStageRollback(txCtx, stage);
                const raw = await this.#catalogRevert(txCtx, name, {
                    version: input.version,
                    operationId: operation.operationId,
                });
                const after = await this.#getCatalog(txCtx, name);
                if (after === undefined) {
                    throw new Error("Worklet catalog removed the worklet during revert.");
                }
                this.#assertMutation(raw, operation, before, after, {
                    name,
                    targetVersion: input.version,
                    stage,
                });
                const proof = this.#proof(operation, before, after, raw);
                await this.#writeEvidence(txCtx, operation, proof, raw);
                if (!raw.changed) {
                    await this.#registerStagePostCommit(
                        txCtx,
                        stage,
                        undefined,
                        stageRegistration,
                    );
                    return { result: raw };
                }
                const event = await this.#newEvent(
                    txCtx,
                    agentId,
                    {
                        type: "worklet_reverted",
                        worklet: after,
                        previousVersion: before.currentVersion,
                    },
                );
                await this.#observeTransactional(txCtx, event);
                await this.#registerStagePostCommit(
                    txCtx,
                    stage,
                    event,
                    stageRegistration,
                );
                return { result: raw, event };
            } catch (error: unknown) {
                if (stage !== undefined) await this.#rollbackStage(txCtx, stage);
                throw error;
            }
        });
        if (result.operation !== "revert") {
            throw new Error("Worklet revert returned the wrong operation.");
        }
        return structuredClone(result.worklet);
    }

    async remove(
        ctx: Context,
        agentId: string,
        name: string,
        operationId?: string,
    ): Promise<boolean> {
        this.#assertAgentId(agentId);
        this.#assertName(name);
        if (operationId !== undefined) this.#assertOperationId(operationId);
        const operation = await this.#operation(
            ctx,
            agentId,
            { kind: "remove", name },
            REMOVE_OPERATION_KEY,
            operationId,
            fingerprint({ agentId, operation: "remove", name }),
        );
        const result = await this.#runTransaction(ctx, "remove", async (txCtx) => {
            const replay = await this.#readReplay(txCtx, operation);
            if (replay !== undefined) {
                if (replay.operation !== "remove") {
                    throw new Error("Worklet remove replay returned the wrong operation.");
                }
                const current = await this.#getCatalog(txCtx, name);
                if (current === undefined) {
                    await this.#reconcileFilesystem(txCtx, name, undefined);
                }
                return { result: replay };
            }
            const before = await this.#getCatalog(txCtx, name);
            if (before !== undefined) {
                await this.#authorize(txCtx, agentId, before.ownerAgentId, "remove");
            } else {
                await this.#reconcileFilesystem(txCtx, name, undefined);
            }
            const raw = await this.#catalogRemove(txCtx, name, operation.operationId);
            const after = await this.#getCatalog(txCtx, name);
            this.#assertMutation(raw, operation, before, after, {
                name,
                targetVersion: 0,
            });
            const proof = this.#proof(operation, before, after, raw);
            await this.#writeEvidence(txCtx, operation, proof, raw);
            if (!raw.changed) return { result: raw };
            if (before === undefined) {
                throw new Error("Worklet remove changed an absent worklet.");
            }
            const event = await this.#newEvent(
                txCtx,
                agentId,
                {
                    type: "worklet_removed",
                    name,
                    ownerAgentId: before.ownerAgentId,
                    previousVersion: before.currentVersion,
                },
            );
            await this.#observeTransactional(txCtx, event);
            await this.#registerRemovePostCommit(txCtx, name, event);
            return { result: raw, event };
        });
        if (result.operation !== "remove") {
            throw new Error("Worklet remove returned the wrong operation.");
        }
        return result.removed;
    }

    async status(
        ctx: Context,
        agentId: string,
        name: string,
    ): Promise<WorkletStatus | undefined> {
        this.#assertAgentId(agentId);
        this.#assertName(name);
        const worklet = await this.#getCatalog(ctx, name);
        if (worklet === undefined) return undefined;
        await this.#authorize(ctx, agentId, worklet.ownerAgentId, "status");
        return await this.#runtimeStatus(ctx, name);
    }

    async readLogs(
        ctx: Context,
        agentId: string,
        name: string,
        query: WorkletLogQuery = {},
    ): Promise<WorkletLogPage> {
        this.#assertAgentId(agentId);
        this.#assertName(name);
        this.#assertInput(workletLogQuerySchema, query, "worklet log query");
        const worklet = await this.#getCatalog(ctx, name);
        if (worklet === undefined) {
            throw new Error(`Worklet "${name}" was not found.`);
        }
        await this.#authorize(ctx, agentId, worklet.ownerAgentId, "logs");
        const limit = query.limit ?? this.#maxLogLines;
        const maxLineCharacters = query.maxLineCharacters ?? this.#maxLogLineCharacters;
        const maxCharacters = query.maxCharacters ?? this.#maxLogCharacters;
        if (
            limit > this.#maxLogLines ||
            maxLineCharacters > this.#maxLogLineCharacters ||
            maxCharacters > this.#maxLogCharacters
        ) {
            throw new Error("Worklet log query exceeds configured bounds.");
        }
        let requestedLimit = limit;
        for (;;) {
            const runtimeQuery: WorkletRuntimeLogQuery = {
                name,
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.from === undefined ? {} : { from: query.from }),
                limit: requestedLimit,
                maxLineCharacters,
                maxCharacters,
            };
            const page = await this.#runtimeLogs(ctx, runtimeQuery);
            if (
                page.name !== name ||
                page.lines.length > requestedLimit ||
                page.lines.some(
                    (line: WorkletLogPage["lines"][number]) =>
                        line.text.length > maxLineCharacters,
                ) ||
                page.lines.reduce(
                    (sum: number, line: WorkletLogPage["lines"][number]) =>
                        sum + line.text.length,
                    0,
                ) > maxCharacters
            ) {
                throw new Error("Worklet runtime returned logs outside the requested bounds.");
            }
            const expectedCursor =
                query.from === "end"
                    ? Math.max(0, page.totalLines - requestedLimit)
                    : (query.cursor ?? 0);
            if (page.cursor !== expectedCursor) {
                throw new Error("Worklet runtime returned logs for a different cursor.");
            }
            if (
                page.cursor > 0 &&
                (query.from === "end" || (query.cursor !== undefined && query.cursor > 0)) &&
                page.previousCursor === undefined
            ) {
                throw new Error(
                    "Worklet runtime must expose a previous cursor for backward log recovery.",
                );
            }
            try {
                this.formatLogsForModel(page);
                return structuredClone(page);
            } catch {
                if (page.lines.length <= 1 || requestedLimit <= 1) {
                    throw new Error(
                        "Worklet log output cannot fit a complete line identity and cursor.",
                    );
                }
                requestedLimit = Math.max(1, Math.floor(requestedLimit / 2));
            }
        }
    }

    async invokeOperation(
        ctx: Context,
        agentId: string,
        input: WorkletInvocationInput,
    ): Promise<WorkletInvocationResult>;
    async invokeOperation(
        ctx: Context,
        agentId: string,
        name: string,
        operation: string,
        args?: WorkletInvocationInput["arguments"],
    ): Promise<WorkletInvocationResult>;
    async invokeOperation(
        ctx: Context,
        agentId: string,
        inputOrName: WorkletInvocationInput | string,
        operation?: string,
        args?: WorkletInvocationInput["arguments"],
    ): Promise<WorkletInvocationResult> {
        this.#assertAgentId(agentId);
        const input: WorkletInvocationInput =
            typeof inputOrName === "string"
                ? {
                      name: inputOrName,
                      operation: operation ?? "",
                      ...(args === undefined ? {} : { arguments: args }),
                  }
                : inputOrName;
        assertAcyclicWithinDepth(
            input,
            MAX_WORKLET_JSON_DEPTH + 2,
            "Worklet operation invocation",
        );
        this.#assertInput(workletInvocationInputSchema, input, "worklet operation invocation");
        const worklet = await this.#getCatalog(ctx, input.name);
        if (worklet === undefined) {
            throw new Error(`Worklet "${input.name}" was not found.`);
        }
        await this.#authorize(ctx, agentId, worklet.ownerAgentId, "invoke");
        if (!worklet.operations.some((declared) => declared.name === input.operation)) {
            throw new Error(
                `Worklet "${input.name}" does not declare operation "${input.operation}".`,
            );
        }
        const invocationArguments = input.arguments ?? {};
        assertBoundedJson(
            invocationArguments,
            this.#maxArgumentDepth,
            this.#maxInvocationBytes,
            "Worklet operation arguments",
        );
        const request: WorkletRuntimeInvocationRequest = {
            name: input.name,
            operation: input.operation,
            arguments: invocationArguments,
            maxDepth: Math.max(this.#maxArgumentDepth, this.#maxResultDepth),
            maxBytes: this.#maxInvocationBytes,
        };
        assertWorkletRuntimeInvocationRequest(request);
        const result = await this.#runtimeInvoke(ctx, request);
        assertWorkletInvocationResult(result);
        if (result.name !== input.name || result.operation !== input.operation) {
            throw new Error("Worklet runtime returned a result for another operation.");
        }
        assertBoundedJson(
            result.result,
            this.#maxResultDepth,
            this.#maxInvocationBytes,
            "Worklet operation result",
        );
        return structuredClone(result);
    }

    formatForModel(worklets: readonly Worklet[]): string {
        for (const worklet of worklets) assertWorklet(worklet);
        const text =
            worklets.length === 0
                ? "No worklets."
                : worklets.map((worklet) => `${worklet.name} v${worklet.currentVersion}`).join("\n");
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Worklet output exceeds the configured model budget.");
        }
        return text;
    }

    formatPageForModel(page: WorkletListPage): string {
        assertWorkletListPage(page);
        const rows = this.formatForModel(page.worklets);
        const cursor = page.nextCursor === undefined ? "" : `\nNext cursor: ${page.nextCursor}`;
        const previous =
            page.previousCursor === undefined
                ? ""
                : `\nPrevious cursor: ${page.previousCursor}`;
        const text = `${rows}${cursor}${previous}`;
        if (text.length > this.#maxOutputCharacters) {
            throw new Error(
                "Worklet output would hide an identity or cursor; request a smaller page.",
            );
        }
        return text;
    }

    formatWorkletForModel(worklet: WorkletDetail | Worklet | undefined): string {
        if (worklet === undefined) return "Worklet not found.";
        if ("status" in worklet) {
            if (!Value.Check(workletDetailSchema, worklet)) {
                throw new Error("Worklet detail is invalid.");
            }
            const { status, ...catalogWorklet } = worklet;
            assertWorklet(catalogWorklet);
            assertWorkletStatus(status);
            const identity = `${worklet.name} v${worklet.currentVersion} (${formatWorkletStatusState(
                status.state,
            )})`;
            if (identity.length > this.#maxOutputCharacters) {
                throw new Error("Worklet output cannot fit the complete identity.");
            }
            return truncateWithMarker(
                `${identity}\nOwner: ${worklet.ownerAgentId}\nOperations: ${worklet.operations
                    .map((operation) => operation.name)
                    .join(", ")}`,
                this.#maxOutputCharacters,
                "\n[details truncated]",
            );
        }
        assertWorklet(worklet);
        const identity = `${worklet.name} v${worklet.currentVersion}`;
        if (identity.length > this.#maxOutputCharacters) {
            throw new Error("Worklet output cannot fit the complete identity.");
        }
        return identity;
    }

    formatOperationForModel(label: string, worklet: Worklet): string {
        assertWorklet(worklet);
        const text = `${label}: ${worklet.name} v${worklet.currentVersion}`;
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Worklet output cannot fit the complete identity.");
        }
        return text;
    }

    formatDetailPageForModel(page: WorkletDetailPage): string {
        assertWorkletDetailPage(page);
        if (page.worklet === null) return "Worklet not found.";
        const identity = `${page.worklet.name} v${page.worklet.currentVersion} detail ${page.cursor}/${page.total}`;
        if (identity.length >= this.#maxOutputCharacters) {
            throw new Error("Worklet detail identity exceeds the model budget.");
        }
        const next =
            page.nextCursor === undefined ? "" : `\nNext cursor: ${page.nextCursor}`;
        const previous =
            page.previousCursor === undefined
                ? ""
                : `\nPrevious cursor: ${page.previousCursor}`;
        const text = `${identity}\n${page.detail}${next}${previous}`;
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Worklet detail exceeds the configured model budget.");
        }
        return text;
    }

    formatStatusForModel(status: WorkletStatus | undefined): string {
        if (status === undefined) return "Worklet not found.";
        assertWorkletStatus(status);
        const identity = `${status.name}: ${formatWorkletStatusState(status.state)}`;
        if (identity.length > this.#maxOutputCharacters) {
            throw new Error("Worklet status exceeds the configured model budget.");
        }
        if (status.detail === undefined) return identity;
        return truncateWithMarker(
            `${identity} — ${status.detail}`,
            this.#maxOutputCharacters,
            "\n[status detail truncated]",
        );
    }

    formatLogsForModel(page: WorkletLogPage): string {
        assertWorkletLogPage(page);
        const header = `${page.name} logs @${page.cursor}`;
        const suffix =
            page.nextCursor === undefined ? "" : `\nNext cursor: ${page.nextCursor}`;
        const previous =
            page.previousCursor === undefined
                ? ""
                : `\nPrevious cursor: ${page.previousCursor}`;
        const fixedTailLength = suffix.length + previous.length;
        if (header.length + fixedTailLength > this.#maxOutputCharacters) {
            throw new Error("Worklet log identity exceeds the model budget.");
        }
        let output = header;
        for (const line of page.lines) {
            const prefix = `${line.position}: `;
            const available = this.#maxOutputCharacters - output.length - fixedTailLength - 1;
            if (available < prefix.length) {
                throw new Error("Worklet log page cannot expose every line identity.");
            }
            const textBudget = available - prefix.length;
            const text =
                line.text.length <= textBudget
                    ? line.text
                    : textBudget <= 1
                      ? line.text.slice(0, textBudget)
                      : `${line.text.slice(0, textBudget - 1)}…`;
            output += `\n${prefix}${text}`;
        }
        output += `${suffix}${previous}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Worklet logs exceed the configured model budget.");
        }
        return output;
    }

    formatInvocationForModel(result: WorkletInvocationResult): string {
        assertAcyclicWithinDepth(
            result,
            MAX_WORKLET_JSON_DEPTH + 2,
            "Worklet operation result",
        );
        assertWorkletInvocationResult(result);
        assertBoundedJson(
            result.result,
            this.#maxResultDepth,
            this.#maxInvocationBytes,
            "Worklet operation result",
        );
        const identity = `${result.name}.${result.operation}`;
        const encoded = safeJsonStringify(result.result);
        if (identity.length >= this.#maxOutputCharacters) {
            throw new Error("Worklet invocation identity exceeds the model budget.");
        }
        return `${identity}: ${truncateWithMarker(
            encoded,
            this.#maxOutputCharacters - identity.length - 2,
            "\n[result truncated]",
        )}`;
    }

    formatRemovalForModel(removed: boolean): string {
        const text = removed ? "Worklet removed." : "Worklet was not found.";
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Worklet removal output exceeds the model budget.");
        }
        return text;
    }

    async #runTransaction(
        ctx: Context,
        operation: string,
        work: (txCtx: Context) => Promise<ModuleChange>,
    ): Promise<WorkletCatalogMutationResult> {
        let expected: ModuleChange | undefined;
        const raw = await requirePromise(
            this.#catalog.transaction.call(this.#catalog, ctx, async (txCtx) => {
                const change = await work(txCtx);
                expected = deepFreeze(structuredClone(change));
                return change;
            }),
            `Worklet ${operation} transaction`,
        );
        assertWorkletTransactionChange(raw);
        if (expected === undefined || !sameValue(raw, expected)) {
            throw new Error(`Worklet ${operation} transaction returned a substituted result.`);
        }
        return structuredClone(expected.result);
    }

    async #operation(
        ctx: Context,
        agentId: string,
        request: WorkletOperationRequest,
        key: string,
        requested: string | undefined,
        requestFingerprint: string,
    ): Promise<WorkletOperation> {
        if (!Value.Check(workletFingerprintSchema, requestFingerprint)) {
            throw new Error("Worklet operation fingerprint is invalid.");
        }
        const operationId = await this.#operationId(
            ctx,
            agentId,
            key,
            requested,
            requestFingerprint,
        );
        const operation = {
            ...request,
            agentId,
            operationId,
            fingerprint: requestFingerprint,
        };
        this.#assertInput(workletOperationSchema, operation, "worklet operation");
        return operation;
    }

    async #operationId(
        ctx: Context,
        agentId: string,
        key: string,
        requested: string | undefined,
        requestFingerprint: string,
    ): Promise<string> {
        if (requested !== undefined) {
            this.#assertOperationId(requested);
            return requested;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) {
            throw new Error(
                "Worklet host mutations require an operationId outside a durable tool call.",
            );
        }
        const state = await kv.update(ctx, key, async (current) => {
            if (current !== undefined) {
                if (!Value.Check(callOperationStateSchema, current)) {
                    throw new Error("Stored worklet operation identity is invalid.");
                }
                if (current.fingerprint !== requestFingerprint) {
                    throw new Error(
                        "The durable worklet operation identity was reused for different input.",
                    );
                }
                return current;
            }
            const id = await this.#newId(ctx, agentId);
            return { id, fingerprint: requestFingerprint };
        });
        if (!Value.Check(callOperationStateSchema, state)) {
            throw new Error("Stored worklet operation identity is invalid.");
        }
        return state.id;
    }

    async #newId(ctx: Context, agentId: string): Promise<string> {
        const raw = this.#idFactory.call(this.#optionsOwner, ctx, agentId);
        const id = await resolveMaybePromise<string>(raw);
        this.#assertOperationId(id);
        return id;
    }

    async #newEvent(
        ctx: Context,
        agentId: string,
        payload:
            | { readonly type: "worklet_installed"; readonly worklet: Worklet }
            | { readonly type: "worklet_updated"; readonly worklet: Worklet }
            | {
                  readonly type: "worklet_reverted";
                  readonly worklet: Worklet;
                  readonly previousVersion: number;
              }
            | {
                  readonly type: "worklet_removed";
                  readonly name: string;
                  readonly ownerAgentId: string;
                  readonly previousVersion: number;
              },
    ): Promise<WorkletEvent> {
        const raw = this.#eventIdFactory.call(this.#optionsOwner, ctx, agentId);
        const eventId = await resolveMaybePromise<string>(raw);
        if (!Value.Check(workletEventIdSchema, eventId)) {
            throw new Error("Worklet event ID factory returned an invalid ID.");
        }
        const event = {
            ...payload,
            eventId,
            at: this.#now(),
            agentId,
        };
        if (!Value.Check(workletEventSchema, event)) {
            throw new Error("Worklet module created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    async #readReplay(
        ctx: Context,
        operation: WorkletOperation,
    ): Promise<WorkletCatalogMutationResult | undefined> {
        const receiptRaw = await requirePromise(
            this.#catalog.readReceipt.call(this.#catalog, ctx, operation.operationId),
            "Worklet catalog readReceipt",
        );
        const proofRaw = await requirePromise(
            this.#catalog.readMutationProof.call(
                this.#catalog,
                ctx,
                operation.operationId,
            ),
            "Worklet catalog readMutationProof",
        );
        if (receiptRaw === undefined && proofRaw === undefined) return undefined;
        if (receiptRaw === undefined || proofRaw === undefined) {
            throw new Error("Worklet operation evidence is incomplete.");
        }
        assertWorkletReceipt(receiptRaw);
        assertWorkletProof(proofRaw);
        if (
            receiptRaw.operation !== operation.kind ||
            proofRaw.operation !== operation.kind ||
            receiptRaw.agentId !== operation.agentId ||
            proofRaw.agentId !== operation.agentId ||
            receiptRaw.operationId !== operation.operationId ||
            proofRaw.operationId !== operation.operationId ||
            receiptRaw.fingerprint !== operation.fingerprint ||
            proofRaw.fingerprint !== operation.fingerprint ||
            receiptRaw.name !== proofRaw.name ||
            receiptRaw.name !== operation.name
        ) {
            throw new Error("Worklet operation identity was reused with different input.");
        }
        if (!sameProofResult(receiptRaw.result, proofRaw.result)) {
            throw new Error("Worklet replay receipt does not match its immutable proof.");
        }
        if (
            receiptRaw.beforeExists !== (proofRaw.before !== null) ||
            receiptRaw.beforeCurrentVersion !== (proofRaw.before?.currentVersion ?? 0)
        ) {
            throw new Error("Worklet replay receipt does not match its immutable before-state.");
        }
        const settledResult = await this.#expandReceiptResult(ctx, receiptRaw);
        this.#assertReplayEvidence(operation, settledResult, proofRaw);
        // Reconciliation is deliberately observational. A later opposite
        // transition must not be undone by replaying an already-committed
        // operation (for example, replaying a removal after recreation).
        const authoritative = await this.#getCatalog(ctx, operation.name);
        this.#assertReplayAuthoritative(operation, settledResult, proofRaw, authoritative);
        if (authoritative !== undefined) {
            await this.#authorize(
                ctx,
                operation.agentId,
                authoritative.ownerAgentId,
                this.#authorizationAction(operation.kind),
            );
        }
        const ownerAgentId = proofRaw.after?.ownerAgentId ?? proofRaw.before?.ownerAgentId;
        if (ownerAgentId !== undefined && ownerAgentId !== authoritative?.ownerAgentId) {
            await this.#authorize(
                ctx,
                operation.agentId,
                ownerAgentId,
                this.#authorizationAction(operation.kind),
            );
        }
        return structuredClone(settledResult);
    }

    async #expandReceiptResult(
        ctx: Context,
        receipt: WorkletCatalogMutationReceipt,
    ): Promise<WorkletCatalogMutationResult> {
        return await this.#expandReceiptResultAt(ctx, receipt, new Set(), 0);
    }

    async #expandReceiptResultAt(
        ctx: Context,
        receipt: WorkletCatalogMutationReceipt,
        ancestors: ReadonlySet<string>,
        depth: number,
    ): Promise<WorkletCatalogMutationResult> {
        if (depth > MAX_WORKLET_VERSIONS) {
            throw new Error("Worklet replay history exceeds its bounded depth.");
        }
        if (ancestors.has(receipt.operationId)) {
            throw new Error("Worklet replay history contains a cycle.");
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(receipt.operationId);
        const compact = receipt.result;
        if (compact.operation === "remove") {
            const result: WorkletCatalogMutationResult = {
                operation: compact.operation,
                name: compact.name,
                operationId: compact.operationId,
                targetVersion: compact.targetVersion,
                currentVersion: compact.currentVersion,
                changed: compact.changed,
                removed: compact.removed,
            };
            assertWorkletMutation(result);
            return result;
        }

        if (compact.operation === "install") {
            const version = structuredClone(compact.version);
            const worklet: Worklet = {
                name: compact.worklet.name,
                ownerAgentId: compact.worklet.ownerAgentId,
                currentVersion: compact.currentVersion,
                operations: structuredClone(version.operations),
                versions: [version],
                createdAt: compact.worklet.createdAt,
                updatedAt: compact.worklet.updatedAt,
            };
            const result: WorkletCatalogMutationResult = {
                operation: compact.operation,
                name: compact.name,
                operationId: compact.operationId,
                targetVersion: compact.targetVersion,
                currentVersion: compact.currentVersion,
                changed: compact.changed,
                worklet,
            };
            assertWorkletMutation(result);
            if (!sameValue(workletStateIdentity(worklet), compact.worklet)) {
                throw new Error("Worklet replay receipt has a mismatched settled worklet.");
            }
            return result;
        }

        const parentReceiptRaw = await requirePromise(
            this.#catalog.readReceipt.call(
                this.#catalog,
                ctx,
                compact.historyOperationId,
            ),
            "Worklet catalog readReceipt for replay history",
        );
        if (parentReceiptRaw === undefined) {
            throw new Error("Worklet replay receipt is missing its history predecessor.");
        }
        assertWorkletReceipt(parentReceiptRaw);
        if (
            parentReceiptRaw.name !== compact.name ||
            parentReceiptRaw.result.operation === "remove"
        ) {
            throw new Error("Worklet replay receipt history targets another worklet.");
        }
        const previousResult = await this.#expandReceiptResultAt(
            ctx,
            parentReceiptRaw,
            nextAncestors,
            depth + 1,
        );
        if (!("worklet" in previousResult)) {
            throw new Error("Worklet replay receipt history has no worklet state.");
        }

        let worklet: Worklet;
        if (compact.operation === "update") {
            const version = structuredClone(compact.version);
            worklet = {
                ...structuredClone(previousResult.worklet),
                currentVersion: compact.currentVersion,
                operations: structuredClone(version.operations),
                versions: [...structuredClone(previousResult.worklet.versions), version],
                updatedAt: compact.worklet.updatedAt,
            };
        } else {
            const target = previousResult.worklet.versions.find(
                (version) => version.version === compact.targetVersion,
            );
            if (target === undefined) {
                throw new Error("Worklet replay receipt is missing its reverted version.");
            }
            worklet = {
                ...structuredClone(previousResult.worklet),
                currentVersion: compact.currentVersion,
                operations: structuredClone(target.operations),
                updatedAt: compact.worklet.updatedAt,
            };
        }
        const result: WorkletCatalogMutationResult = {
            operation: compact.operation,
            name: compact.name,
            operationId: compact.operationId,
            targetVersion: compact.targetVersion,
            currentVersion: compact.currentVersion,
            changed: compact.changed,
            worklet,
        };
        assertWorkletMutation(result);
        if (!sameValue(workletStateIdentity(worklet), compact.worklet)) {
            throw new Error("Worklet replay receipt has a mismatched settled worklet.");
        }
        return result;
    }

    #assertReplayAuthoritative(
        operation: WorkletOperation,
        settledResult: WorkletCatalogMutationResult,
        proof: WorkletCatalogMutationProof,
        authoritative: Worklet | undefined,
    ): void {
        if (authoritative === undefined || operation.kind === "remove") return;
        if (
            proof.after === null ||
            authoritative.name !== operation.name ||
            !("worklet" in settledResult)
        ) {
            throw new Error("Worklet replay returned an unrelated authoritative record.");
        }
        const expected = settledResult.worklet;
        const generationChanged =
            authoritative.versions[0]?.operationId !== expected.versions[0]?.operationId;
        if (generationChanged) {
            // A remove followed by a legitimate reinstall starts a new
            // generation. The old durable call is settled and must be
            // returned without applying it to the new row.
            return;
        }
        const historyExtends =
            authoritative.ownerAgentId === expected.ownerAgentId &&
            authoritative.createdAt === expected.createdAt &&
            authoritative.versions.length >= expected.versions.length &&
            sameValue(
                authoritative.versions.slice(0, expected.versions.length),
                expected.versions,
            );
        if (!historyExtends) {
            throw new Error(
                "Worklet replay did not match the authoritative catalog record.",
            );
        }
        if (
            authoritative.versions.length === expected.versions.length &&
            authoritative.currentVersion === expected.currentVersion &&
            !sameValue(workletStateIdentity(authoritative), proof.after)
        ) {
            throw new Error(
                "Worklet replay did not match the authoritative catalog record.",
            );
        }
    }

    #assertReplayEvidence(
        operation: WorkletOperation,
        settledResult: WorkletCatalogMutationResult,
        proof: WorkletCatalogMutationProof,
    ): void {
        const result = settledResult;
        const proofResult = proof.result;
        if (
            result.operation !== operation.kind ||
            proofResult.operation !== operation.kind ||
            result.name !== operation.name ||
            proofResult.name !== result.name ||
            proofResult.operationId !== result.operationId
        ) {
            throw new Error("Worklet replay evidence has a different operation target.");
        }
        if (operation.kind === "remove") {
            if (
                proof.after !== null ||
                (proof.before !== null && proof.before.name !== operation.name) ||
                ("worklet" in result) ||
                ("worklet" in proofResult) ||
                result.removed !== result.changed ||
                result.changed !== (proof.before !== null) ||
                result.targetVersion !== 0 ||
                result.currentVersion !== 0
            ) {
                throw new Error("Worklet remove replay evidence is inconsistent.");
            }
            return;
        }
        if (
            proof.after === null ||
            !("worklet" in result) ||
            !("worklet" in proofResult)
        ) {
            throw new Error("Worklet replay evidence is missing its resulting worklet.");
        }
        const after = proof.after;
        const afterRecord = result.worklet;
        if (!sameValue(after, workletStateIdentity(afterRecord))) {
            throw new Error("Worklet replay evidence does not match its after-state.");
        }
        if (
            after.name !== operation.name ||
            result.targetVersion !== after.currentVersion ||
            result.currentVersion !== after.currentVersion
        ) {
            throw new Error("Worklet replay evidence has an invalid target version.");
        }
        if (operation.kind === "install") {
            const initial = afterRecord.versions[0];
            if (
                proof.before !== null ||
                result.changed !== true ||
                result.targetVersion !== 1 ||
                after.ownerAgentId !== operation.agentId ||
                after.currentVersion !== 1 ||
                after.versionCount !== 1 ||
                after.updatedAt !== after.createdAt ||
                initial?.operationId !== operation.operationId ||
                initial.sourceRef !== operation.sourceRef ||
                initial.changeDescription !== "Initial install"
            ) {
                throw new Error("Worklet install replay evidence does not match the request.");
            }
            return;
        }
        if (proof.before === null || proof.before.name !== after.name) {
            throw new Error("Worklet replay evidence is missing its before-state.");
        }
        if (operation.kind === "update") {
            const appended = afterRecord.versions.at(-1);
            if (
                result.changed !== true ||
                result.targetVersion !== after.versionCount ||
                after.versionCount !== proof.before.versionCount + 1 ||
                after.ownerAgentId !== proof.before.ownerAgentId ||
                after.createdAt !== proof.before.createdAt ||
                appended?.createdAt !== after.updatedAt ||
                appended?.operationId !== operation.operationId ||
                appended.sourceRef !== operation.sourceRef ||
                appended.changeDescription !== operation.changeDescription
            ) {
                throw new Error("Worklet update replay evidence does not match the request.");
            }
            return;
        }
        if (
            result.targetVersion !== operation.version ||
            after.currentVersion !== operation.version ||
            result.changed !== (proof.before.currentVersion !== operation.version) ||
            after.ownerAgentId !== proof.before.ownerAgentId ||
            after.createdAt !== proof.before.createdAt ||
            after.updatedAt !== proof.before.updatedAt
        ) {
            throw new Error("Worklet revert replay evidence does not match the request.");
        }
    }

    #proof(
        operation: WorkletOperation,
        before: Worklet | undefined,
        after: Worklet | undefined,
        result: WorkletCatalogMutationResult,
    ): WorkletCatalogMutationProof {
        const proof: WorkletCatalogMutationProof = {
            operation: operation.kind,
            agentId: operation.agentId,
            name: "worklet" in result ? result.worklet.name : result.name,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            before: before === undefined ? null : workletStateIdentity(before),
            after: after === undefined ? null : workletStateIdentity(after),
            changed: result.changed,
            result: compactProofResult(result),
        };
        assertWorkletProof(proof);
        return proof;
    }

    async #writeEvidence(
        ctx: Context,
        operation: WorkletOperation,
        proof: WorkletCatalogMutationProof,
        settledResult: WorkletCatalogMutationResult,
    ): Promise<void> {
        assertWorkletProof(proof);
        assertWorkletMutation(settledResult);
        if (
            proof.agentId !== operation.agentId ||
            proof.operationId !== operation.operationId ||
            proof.operation !== operation.kind ||
            proof.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Worklet mutation proof does not match its operation.");
        }
        const receipt: WorkletCatalogMutationReceipt = {
            operation: proof.operation,
            agentId: proof.agentId,
            name: proof.name,
            operationId: proof.operationId,
            fingerprint: proof.fingerprint,
            beforeExists: proof.before !== null,
            beforeCurrentVersion: proof.before?.currentVersion ?? 0,
            result: compactReceiptResult(settledResult),
        };
        assertWorkletReceipt(receipt);
        const expectedProof = deepFreeze(structuredClone(proof));
        await invokePromiseVoid(
            this.#catalog.writeMutationProof.call(
                this.#catalog,
                ctx,
                structuredClone(expectedProof),
            ),
            "Worklet catalog writeMutationProof",
        );
        const retainedProof = await requirePromise(
            this.#catalog.readMutationProof.call(
                this.#catalog,
                ctx,
                operation.operationId,
            ),
            "Worklet catalog readMutationProof after write",
        );
        if (retainedProof === undefined) {
            throw new Error("Worklet catalog did not retain the mutation proof.");
        }
        assertWorkletProof(retainedProof);
        if (!sameValue(retainedProof, expectedProof)) {
            throw new Error("Worklet catalog retained a mismatched mutation proof.");
        }

        const expectedReceipt = deepFreeze(structuredClone(receipt));
        await invokePromiseVoid(
            this.#catalog.writeReceipt.call(
                this.#catalog,
                ctx,
                structuredClone(expectedReceipt),
            ),
            "Worklet catalog writeReceipt",
        );
        const retainedReceipt = await requirePromise(
            this.#catalog.readReceipt.call(
                this.#catalog,
                ctx,
                operation.operationId,
            ),
            "Worklet catalog readReceipt after write",
        );
        if (retainedReceipt === undefined) {
            throw new Error("Worklet catalog did not retain the replay receipt.");
        }
        assertWorkletReceipt(retainedReceipt);
        if (!sameValue(retainedReceipt, expectedReceipt)) {
            throw new Error("Worklet catalog retained a mismatched replay receipt.");
        }
    }

    #assertMutation(
        raw: WorkletCatalogMutationResult,
        operation: WorkletOperation,
        before: Worklet | undefined,
        after: Worklet | undefined,
        details: {
            readonly name: string;
            readonly targetVersion: number;
            readonly changeDescription?: string;
            readonly createdAt?: number;
            readonly stage?: WorkletStage;
        },
    ): void {
        assertWorkletMutation(raw);
        if (
            raw.operation !== operation.kind ||
            raw.name !== details.name ||
            raw.operationId !== operation.operationId
        ) {
            throw new Error("Worklet catalog returned a different requested operation.");
        }
        const derivedChanged =
            before === undefined
                ? after !== undefined
                : after === undefined || !sameValue(before, after);
        if (raw.changed !== derivedChanged) {
            throw new Error("Worklet catalog changed flag disagrees with authoritative state.");
        }
        if (operation.kind === "remove") {
            if (
                raw.targetVersion !== 0 ||
                raw.currentVersion !== 0 ||
                !("removed" in raw) ||
                raw.removed !== derivedChanged ||
                after !== undefined
            ) {
                throw new Error("Worklet remove result has invalid transition semantics.");
            }
            return;
        }
        if (after === undefined || !("worklet" in raw)) {
            throw new Error("Worklet mutation did not return an authoritative worklet.");
        }
        if (
            raw.targetVersion !== details.targetVersion ||
            raw.currentVersion !== after.currentVersion ||
            !sameValue(raw.worklet, after)
        ) {
            throw new Error("Worklet mutation result does not match authoritative state.");
        }
        if (operation.kind === "install") {
            if (
                before !== undefined ||
                !derivedChanged ||
                after.ownerAgentId !== operation.agentId ||
                after.currentVersion !== 1 ||
                after.versions.length !== 1 ||
                (details.createdAt !== undefined && after.createdAt !== details.createdAt) ||
                details.stage === undefined ||
                after.versions[0]?.operationId !== operation.operationId ||
                after.versions[0]?.sourceRef !== details.stage.sourceRef ||
                after.versions[0]?.changeDescription !== "Initial install" ||
                (details.createdAt !== undefined &&
                    after.versions[0]?.createdAt !== details.createdAt) ||
                !sameValue(after.operations, details.stage.operations)
            ) {
                throw new Error("Worklet install result does not match the requested import.");
            }
            return;
        }
        if (before === undefined) {
            throw new Error("Worklet mutation is missing its before-state snapshot.");
        }
        if (operation.kind === "update") {
            if (
                !derivedChanged ||
                details.stage === undefined ||
                after.ownerAgentId !== before.ownerAgentId ||
                after.createdAt !== before.createdAt ||
                after.versions.length !== before.versions.length + 1 ||
                after.currentVersion !== details.targetVersion ||
                (details.createdAt !== undefined && after.updatedAt !== details.createdAt) ||
                !sameValue(
                    after.versions.slice(0, before.versions.length),
                    before.versions,
                ) ||
                after.versions.at(-1)?.operationId !== operation.operationId ||
                after.versions.at(-1)?.sourceRef !== details.stage.sourceRef ||
                after.versions.at(-1)?.changeDescription !== details.changeDescription ||
                (details.createdAt !== undefined &&
                    after.versions.at(-1)?.createdAt !== details.createdAt) ||
                !sameValue(after.operations, details.stage.operations)
            ) {
                throw new Error("Worklet update result did not append exactly one version.");
            }
            return;
        }
        if (
            after.ownerAgentId !== before.ownerAgentId ||
            !sameValue(after.versions, before.versions) ||
            after.currentVersion !== details.targetVersion ||
            raw.changed !== (before.currentVersion !== details.targetVersion) ||
            details.stage === undefined ||
            after.versions.find((version) => version.version === details.targetVersion)
                ?.sourceRef !== details.stage.sourceRef ||
            !sameValue(after.operations, details.stage.operations)
        ) {
            throw new Error("Worklet revert result has invalid version semantics.");
        }
        if (!raw.changed && after.updatedAt !== before.updatedAt) {
            throw new Error("Worklet revert no-op changed the catalog timestamp.");
        }
    }

    async #stage(ctx: Context, input: Static<typeof workletStageInputSchema>): Promise<WorkletStage> {
        this.#assertInput(workletStageInputSchema, input, "worklet stage request");
        let raw: unknown;
        try {
            raw = await requirePromise(
                this.#installer.stage(ctx, input),
                "Worklet installer stage",
            );
            assertWorkletStage(raw);
            if (
                raw.name !== input.name ||
                raw.ownerAgentId !== input.ownerAgentId ||
                raw.version !== input.version ||
                raw.sourceRef !== input.sourceRef ||
                raw.operationId !== input.operationId
            ) {
                throw new Error("Worklet stage does not match the requested source.");
            }
            return structuredClone(raw);
        } catch (error: unknown) {
            if (Value.Check(workletStageSchema, raw)) {
                await this.#rollbackStage(ctx, raw);
            }
            throw error;
        }
    }

    async #reconcileFilesystem(
        ctx: Context,
        name: string,
        worklet: Worklet | undefined,
    ): Promise<void> {
        await invokePromiseVoid(
            this.#installer.reconcileWorklet(ctx, name, worklet),
            "Worklet installer reconciliation",
        );
    }

    async #commitStage(ctx: Context, stage: WorkletStage): Promise<void> {
        await invokePromiseVoid(
            this.#installer.commit(ctx, stage),
            "Worklet installer commit",
        );
    }

    async #registerStageRollback(
        ctx: Context,
        stage: WorkletStage,
    ): Promise<StageRegistration> {
        let settled = false;
        const rollbackNow = async (rollbackCtx: Context): Promise<void> => {
            if (settled) return;
            settled = true;
            await this.#rollbackStage(rollbackCtx, stage);
        };
        return { rollbackNow, markCommitted: () => (settled = true) };
    }

    async #registerStagePostCommit(
        ctx: Context,
        stage: WorkletStage,
        event: WorkletEvent | undefined,
        registration: StageRegistration,
    ): Promise<void> {
        try {
            afterCommit(
                ctx,
                async (postCommitCtx) => {
                    try {
                        registration.markCommitted();
                        await this.#installer.finalize(postCommitCtx, stage);
                        if (event !== undefined) {
                            await this.#notifyPostCommit(postCommitCtx, event);
                        }
                    } catch (error: unknown) {
                        if (event !== undefined) {
                            await this.#reportPostCommitError(postCommitCtx, event, error);
                        }
                    }
                },
            );
        } catch (error: unknown) {
            await registration.rollbackNow(ctx);
            throw error;
        }
    }

    /**
     * After a removal durably commits, delete the worklet's code — its icon and
     * every version folder — while keeping its `Data` folder. Cleanup is best
     * effort and never turns a committed removal into a caller-visible failure.
     */
    async #registerRemovePostCommit(
        ctx: Context,
        name: string,
        event: WorkletEvent,
    ): Promise<void> {
        afterCommit(
            ctx,
            async (postCommitCtx) => {
                try {
                    await this.#reconcileFilesystem(postCommitCtx, name, undefined);
                } catch (error: unknown) {
                    // The durable removal already committed. Keep the failure
                    // contained, but surface it through the explicit observer
                    // error channel instead of silently discarding it.
                    await this.#reportPostCommitError(postCommitCtx, event, error);
                }
                await this.#notifyPostCommit(postCommitCtx, event);
            },
        );
    }

    async #rollbackStage(ctx: Context, stage: WorkletStage): Promise<void> {
        try {
            await invokePromiseVoid(
                this.#installer.rollback(ctx, stage),
                "Worklet installer rollback",
            );
        } catch {
            // Cleanup is advisory after the original error; the installer keeps
            // ownership of removing the staged files it created.
        }
    }

    async #observeTransactional(ctx: Context, event: WorkletEvent): Promise<void> {
        if (!Object.isFrozen(event)) {
            throw new Error("Worklet event must be deeply frozen before observation.");
        }
        const callback = this.#listener?.onEventTransactional;
        if (callback !== undefined) {
            await invokeVoidOrPromise(
                callback.call(this.#listener, ctx, event),
                "Worklet transactional listener",
            );
        }
    }

    async #notifyPostCommit(ctx: Context, event: WorkletEvent): Promise<void> {
        try {
            const callback = this.#listener?.onEvent;
            if (callback !== undefined) {
                await invokeVoidOrPromise(
                    callback.call(this.#listener, ctx, event),
                    "Worklet post-commit listener",
                );
            }
        } catch (error: unknown) {
            await this.#reportPostCommitError(ctx, event, error);
        }
    }

    async #reportPostCommitError(
        ctx: Context,
        event: WorkletEvent,
        error: unknown,
    ): Promise<void> {
        if (this.#onPostCommitError === undefined) return;
        try {
            await invokeVoidOrPromise(
                this.#onPostCommitError.call(this.#optionsOwner, ctx, event, error),
                "Worklet post-commit error handler",
            );
        } catch {
            // Reporting is advisory and must never turn a committed mutation
            // into a caller-visible failure.
        }
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        ownerAgentId: string,
        action: WorkletAuthorizationAction,
    ): Promise<void> {
        if (actingAgentId === ownerAgentId) return;
        if (this.#authorization === undefined) return;
        const raw = this.#authorization.call(
            this.#optionsOwner,
            ctx,
            actingAgentId,
            ownerAgentId,
            action,
        );
        if (!(raw instanceof Promise) && typeof raw !== "boolean") {
            throw new Error("Worklet authorization returned an invalid result.");
        }
        const allowed = await (raw instanceof Promise ? raw : Promise.resolve(raw));
        if (typeof allowed !== "boolean") {
            throw new Error("Worklet authorization returned an invalid result.");
        }
        if (!allowed) throw new Error("Cross-agent worklet access is not authorized.");
    }

    async #getCatalog(ctx: Context, name: string): Promise<Worklet | undefined> {
        const raw = await requirePromise(
            this.#catalog.get.call(this.#catalog, ctx, name),
            "Worklet catalog get",
        );
        if (raw === undefined) return undefined;
        assertWorklet(raw);
        if (raw.name !== name) {
            throw new Error("Worklet catalog returned a different worklet name.");
        }
        return structuredClone(raw);
    }

    async #listCatalog(
        ctx: Context,
        query: WorkletListQuery,
    ): Promise<WorkletListPage> {
        let limit = query.limit ?? this.#maxPageSize;
        for (;;) {
            const raw = await requirePromise(
                this.#catalog.list.call(this.#catalog, ctx, {
                    ...query,
                    limit,
                }),
                "Worklet catalog list",
            );
            assertWorkletListPageShape(raw);
            if (raw.limit !== limit || raw.worklets.length > limit) {
                throw new Error("Worklet catalog returned a page outside the requested bound.");
            }
            try {
                assertWorkletListPage(raw);
                return structuredClone(raw);
            } catch (error: unknown) {
                if (
                    raw.worklets.length > 1 &&
                    error instanceof Error &&
                    error.message.includes("aggregate byte bound")
                ) {
                    limit = Math.max(1, Math.min(limit - 1, raw.worklets.length - 1));
                    continue;
                }
                throw error;
            }
        }
    }

    async #catalogInstall(
        ctx: Context,
        input: WorkletCatalogInstallInput,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "install" }>> {
        const raw = await requirePromise(
            this.#catalog.install.call(this.#catalog, ctx, input),
            "Worklet catalog install",
        );
        assertWorkletMutation(raw);
        if (raw.operation !== "install") {
            throw new Error("Worklet catalog install returned the wrong operation.");
        }
        return raw;
    }

    async #catalogUpdate(
        ctx: Context,
        name: string,
        input: WorkletCatalogUpdateInput,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "update" }>> {
        const raw = await requirePromise(
            this.#catalog.update.call(this.#catalog, ctx, name, input),
            "Worklet catalog update",
        );
        assertWorkletMutation(raw);
        if (raw.operation !== "update") {
            throw new Error("Worklet catalog update returned the wrong operation.");
        }
        return raw;
    }

    async #catalogRevert(
        ctx: Context,
        name: string,
        input: WorkletCatalogRevertInput,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "revert" }>> {
        const raw = await requirePromise(
            this.#catalog.revert.call(this.#catalog, ctx, name, input),
            "Worklet catalog revert",
        );
        assertWorkletMutation(raw);
        if (raw.operation !== "revert") {
            throw new Error("Worklet catalog revert returned the wrong operation.");
        }
        return raw;
    }

    async #catalogRemove(
        ctx: Context,
        name: string,
        operationId: string,
    ): Promise<Extract<WorkletCatalogMutationResult, { operation: "remove" }>> {
        const raw = await requirePromise(
            this.#catalog.remove.call(this.#catalog, ctx, name, operationId),
            "Worklet catalog remove",
        );
        assertWorkletMutation(raw);
        if (raw.operation !== "remove") {
            throw new Error("Worklet catalog remove returned the wrong operation.");
        }
        return raw;
    }

    async #runtimeStatus(ctx: Context, name: string): Promise<WorkletStatus> {
        const raw = await requirePromise(
            this.#runtime.status.call(this.#runtime, ctx, name),
            "Worklet runtime status",
        );
        assertWorkletStatus(raw);
        if (raw.name !== name) throw new Error("Worklet runtime returned another status.");
        return structuredClone(raw);
    }

    async #runtimeLogs(
        ctx: Context,
        query: WorkletRuntimeLogQuery,
    ): Promise<WorkletLogPage> {
        assertWorkletRuntimeLogQuery(query);
        const raw = await requirePromise(
            this.#runtime.readLogs.call(this.#runtime, ctx, query),
            "Worklet runtime logs",
        );
        assertWorkletLogPage(raw);
        return structuredClone(raw);
    }

    async #runtimeInvoke(
        ctx: Context,
        request: WorkletRuntimeInvocationRequest,
    ): Promise<WorkletInvocationResult> {
        const raw = await requirePromise(
            this.#runtime.invokeOperation.call(this.#runtime, ctx, request),
            "Worklet runtime operation",
        );
        assertAcyclicWithinDepth(
            raw,
            MAX_WORKLET_JSON_DEPTH + 2,
            "Worklet operation result",
        );
        assertWorkletInvocationResult(raw);
        return structuredClone(raw);
    }

    #detail(worklet: Worklet, status: WorkletStatus): WorkletDetail {
        const detail = { ...structuredClone(worklet), status: structuredClone(status) };
        if (!Value.Check(workletDetailSchema, detail)) {
            throw new Error("Worklet detail is invalid.");
        }
        return detail;
    }

    #detailText(detail: WorkletDetail): string {
        const lines = [
            `Name: ${detail.name}`,
            `Owner: ${detail.ownerAgentId}`,
            `Current version: ${detail.currentVersion}`,
            `Status: ${formatWorkletStatusState(detail.status.state)}`,
            ...(detail.status.detail === undefined ? [] : [`Status detail: ${detail.status.detail}`]),
            `Created at: ${detail.createdAt}`,
            `Updated at: ${detail.updatedAt}`,
            "Version history:",
            ...detail.versions.map(
                (version) =>
                    `v${version.version} ${version.sourceRef} — ${version.changeDescription} (${version.createdAt})`,
            ),
            "Declared operations:",
            ...(detail.operations.length === 0
                ? ["(none)"]
                : detail.operations.map((operation) =>
                      operation.description === undefined
                          ? `- ${operation.name}`
                          : `- ${operation.name}: ${operation.description}`,
                  )),
        ];
        const text = lines.join("\n");
        if (text.length > MAX_WORKLET_DETAIL_CHARACTERS) {
            throw new Error("Worklet detail exceeds the configured storage bound.");
        }
        return text;
    }

    #assertListPage(
        page: WorkletListPage,
        requestedLimit: number,
        requestedCursor: number | undefined,
    ): void {
        assertWorkletListPage(page);
        if (page.limit !== requestedLimit || page.worklets.length > requestedLimit) {
            throw new Error("Worklet catalog returned a page outside the requested bound.");
        }
        if (page.hasMore) {
            if (page.nextCursor === undefined || page.worklets.length === 0) {
                throw new Error("Worklet catalog returned a non-progressing page.");
            }
            const expected = (requestedCursor ?? 0) + page.worklets.length;
            if (page.nextCursor !== expected) {
                throw new Error("Worklet catalog cursor must advance by visible records.");
            }
        } else if (page.nextCursor !== undefined) {
            throw new Error("Worklet catalog returned a cursor for a terminal page.");
        }
        if (
            page.previousCursor !== undefined &&
            (requestedCursor === undefined || page.previousCursor >= requestedCursor)
        ) {
            throw new Error("Worklet catalog returned a non-progressing previous cursor.");
        }
        if (
            requestedCursor !== undefined &&
            requestedCursor > 0 &&
            page.worklets.length === 0 &&
            page.previousCursor === undefined
        ) {
            throw new Error(
                "Worklet catalog must expose a previous cursor for an empty page beyond the start.",
            );
        }
    }

    #authorizationAction(kind: WorkletCatalogOperation): WorkletAuthorizationAction {
        return kind;
    }

    #assertAgentId(value: unknown): asserts value is string {
        if (!Value.Check(workletAgentIdSchema, value)) {
            throw new Error("Worklet agent ID is invalid.");
        }
    }

    #assertName(value: unknown): asserts value is string {
        if (!Value.Check(workletNameSchema, value)) {
            throw new Error("Worklet name is invalid.");
        }
    }

    #assertOperationId(value: unknown): asserts value is string {
        if (!Value.Check(workletAgentIdSchema, value)) {
            throw new Error("Worklet operation ID is invalid.");
        }
    }

    #assertInput<T>(schema: unknown, value: unknown, label: string): asserts value is T {
        if (!Value.Check(schema as Parameters<typeof Value.Check>[0], value)) {
            throw new Error(`Invalid ${label} input.`);
        }
    }

    #now(): number {
        const value = this.#clock.call(this.#optionsOwner);
        if (!Value.Check(workletTimestampSchema, value)) {
            throw new Error("Worklet clock returned an invalid timestamp.");
        }
        return value;
    }
}

export function assertWorkletModuleOptions(
    value: unknown,
): asserts value is WorkletModuleOptions {
    if (!Value.Check(workletModuleOptionsSchema, value)) {
        throw new Error("Worklet module options are invalid.");
    }
}

function formatWorkletStatusState(state: WorkletStatus["state"]): string {
    switch (state) {
        case "running":
            return "running normally";
        case "running/awake":
            return "running and awake";
        case "awake":
            return "awake and ready";
        case "asleep":
            return "sleeping";
        case "stopped":
            return "stopped";
        case "failed":
            return "failed";
    }
}

function compactProofResult(
    result: WorkletCatalogMutationResult,
): WorkletCatalogMutationProofResult {
    if (!("worklet" in result)) {
        return structuredClone(result) as WorkletCatalogMutationProofResult;
    }
    return {
        ...result,
        worklet: workletStateIdentity(result.worklet),
    } as WorkletCatalogMutationProofResult;
}

function compactReceiptResult(
    result: WorkletCatalogMutationResult,
): WorkletCatalogMutationReceiptResult {
    if (result.operation === "remove") {
        return structuredClone(result) as WorkletCatalogMutationReceiptResult;
    }
    const identity = workletStateIdentity(result.worklet);
    if (result.operation === "install") {
        const version: WorkletVersion | undefined = result.worklet.versions[0];
        if (version === undefined) {
            throw new Error("Worklet install result has no initial version.");
        }
        return {
            ...result,
            worklet: identity,
            version: structuredClone(version),
        } as WorkletCatalogMutationReceiptResult;
    }
    if (result.operation === "update") {
        const version = result.worklet.versions.at(-1);
        const previousVersion = result.worklet.versions.at(-2);
        if (version === undefined || previousVersion === undefined) {
            throw new Error("Worklet update result has no version predecessor.");
        }
        return {
            ...result,
            worklet: identity,
            version: structuredClone(version),
            historyOperationId: previousVersion.operationId,
        } as WorkletCatalogMutationReceiptResult;
    }
    const latestVersion = result.worklet.versions.at(-1);
    if (latestVersion === undefined) {
        throw new Error("Worklet revert result has no version history.");
    }
    return {
        ...result,
        worklet: identity,
        historyOperationId: latestVersion.operationId,
    } as WorkletCatalogMutationReceiptResult;
}

function fingerprint(value: unknown): string {
    const encoded = JSON.stringify(canonicalize(value));
    if (
        encoded === undefined ||
        new TextEncoder().encode(encoded).byteLength > 16_000
    ) {
        throw new Error("Worklet operation input exceeds the durable receipt bound.");
    }
    return createHash("sha256").update(encoded).digest("hex");
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, item]) => [key, canonicalize(item)]),
        );
    }
    return value;
}

function assertBoundedJson(
    value: unknown,
    maxDepth: number,
    maxBytes: number,
    label: string,
): void {
    const stack: TraversalFrame[] = [{ value, depth: 0, leaving: false }];
    const active = new WeakSet<object>();
    while (stack.length > 0) {
        const frame = stack.pop()!;
        const current = frame.value;
        if (frame.leaving) {
            if (current !== null && typeof current === "object") {
                active.delete(current);
            }
            continue;
        }
        if (frame.depth > maxDepth) {
            throw new Error(`${label} exceeds the maximum JSON depth.`);
        }
        if (typeof current === "string") {
            if (current.length > MAX_WORKLET_JSON_STRING_LENGTH) {
                throw new Error(`${label} contains an oversized string.`);
            }
            continue;
        }
        if (current === null || typeof current !== "object") {
            if (typeof current === "number" && !Number.isFinite(current)) {
                throw new Error(`${label} contains a non-finite number.`);
            }
            continue;
        }
        if (active.has(current)) throw new Error(`${label} must be acyclic JSON.`);
        active.add(current);
        stack.push({ value: current, depth: frame.depth, leaving: true });
        if (Array.isArray(current)) {
            if (current.length > MAX_WORKLET_JSON_ITEMS) {
                throw new Error(`${label} contains too many array items.`);
            }
            for (let index = current.length - 1; index >= 0; index -= 1) {
                stack.push({
                    value: current[index],
                    depth: frame.depth + 1,
                    leaving: false,
                });
            }
            continue;
        }
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`${label} must contain plain JSON objects.`);
        }
        const entries = enumerableEntries(current);
        if (entries.length > MAX_WORKLET_JSON_PROPERTIES) {
            throw new Error(`${label} contains too many object properties.`);
        }
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const [key, item] = entries[index]!;
            if (key.length > MAX_WORKLET_JSON_KEY_LENGTH) {
                throw new Error(`${label} contains an oversized object key.`);
            }
            stack.push({ value: item, depth: frame.depth + 1, leaving: false });
        }
    }
    if (!Value.Check(workletJsonValueSchema, value)) {
        throw new Error(`${label} has an invalid JSON shape.`);
    }
    const encoded = safeJsonStringify(value);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > maxBytes) throw new Error(`${label} exceeds the encoded-byte bound.`);
}

interface TraversalFrame {
    readonly value: unknown;
    readonly depth: number;
    readonly leaving: boolean;
}

function assertAcyclicWithinDepth(
    value: unknown,
    maxDepth: number,
    label: string,
): void {
    const stack: TraversalFrame[] = [{ value, depth: 0, leaving: false }];
    const active = new WeakSet<object>();
    while (stack.length > 0) {
        const frame = stack.pop()!;
        const current = frame.value;
        if (frame.leaving) {
            if (current !== null && typeof current === "object") {
                active.delete(current);
            }
            continue;
        }
        if (frame.depth > maxDepth) {
            throw new Error(`${label} exceeds the maximum JSON depth.`);
        }
        if (current === null || typeof current !== "object") continue;
        if (active.has(current)) throw new Error(`${label} must be acyclic JSON.`);
        active.add(current);
        stack.push({ value: current, depth: frame.depth, leaving: true });
        if (Array.isArray(current)) {
            if (current.length > MAX_WORKLET_JSON_ITEMS) {
                throw new Error(`${label} contains too many array items.`);
            }
            for (let index = current.length - 1; index >= 0; index -= 1) {
                stack.push({
                    value: current[index],
                    depth: frame.depth + 1,
                    leaving: false,
                });
            }
            continue;
        }
        const entries = enumerableEntries(current);
        if (entries.length > MAX_WORKLET_JSON_PROPERTIES) {
            throw new Error(`${label} contains too many object properties.`);
        }
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            stack.push({
                value: entries[index]![1],
                depth: frame.depth + 1,
                leaving: false,
            });
        }
    }
}

function enumerableEntries(value: object): Array<[string, unknown]> {
    const entries: Array<[string, unknown]> = [];
    for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        entries.push([key, (value as Record<string, unknown>)[key]]);
        if (entries.length > MAX_WORKLET_JSON_PROPERTIES) break;
    }
    return entries;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const nested of Object.values(value as Record<string, unknown>)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}

function sameValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((item, index) => sameValue(item, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.prototype.hasOwnProperty.call(rightRecord, key) &&
                sameValue(leftRecord[key], rightRecord[key]),
        )
    );
}

function sameProofResult(
    result: WorkletCatalogMutationReceiptResult,
    proofResult: WorkletCatalogMutationProofResult,
): boolean {
    if ("worklet" in result || "worklet" in proofResult) {
        if (!("worklet" in result) || !("worklet" in proofResult)) return false;
        const receiptRest = {
            operation: result.operation,
            name: result.name,
            operationId: result.operationId,
            targetVersion: result.targetVersion,
            currentVersion: result.currentVersion,
            changed: result.changed,
        };
        const proofRest = {
            operation: proofResult.operation,
            name: proofResult.name,
            operationId: proofResult.operationId,
            targetVersion: proofResult.targetVersion,
            currentVersion: proofResult.currentVersion,
            changed: proofResult.changed,
        };
        return (
            sameValue(receiptRest, proofRest) &&
            sameValue(result.worklet, proofResult.worklet)
        );
    }
    return sameValue(result, proofResult);
}

function safeJsonStringify(value: unknown): string {
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error("not JSON");
        return encoded;
    } catch {
        throw new Error("Value is not JSON encodable.");
    }
}

function truncateWithMarker(text: string, maximum: number, marker: string): string {
    if (maximum <= 0) return "";
    if (text.length <= maximum) return text;
    if (maximum <= marker.length) return text.slice(0, maximum);
    return `${text.slice(0, maximum - marker.length)}${marker}`;
}

async function requirePromise<T>(value: unknown, operation: string): Promise<T> {
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    return await value;
}

async function resolveMaybePromise<T>(value: T | Promise<T>): Promise<T> {
    return value instanceof Promise ? await value : value;
}

async function invokePromiseVoid(value: unknown, operation: string): Promise<void> {
    const resolved = await requirePromise<unknown>(value, operation);
    if (resolved !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}

async function invokeVoidOrPromise(value: unknown, operation: string): Promise<void> {
    if (value === undefined) return;
    await invokePromiseVoid(value, operation);
}
