import { sql } from "drizzle-orm";
import {
    agentKV,
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    withAgentDatabase,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_WORKLET_LIST_SIZE,
    MAX_WORKLET_VERSIONS,
    workletAgentIdSchema,
    workletListPageSchema,
    workletListQuerySchema,
    workletNameSchema,
    workletVersionSchema,
    type Worklet,
} from "./Worklet.js";
import {
    assertWorklet,
    assertWorkletMutation,
    workletCatalogInstallInputSchema,
    workletCatalogRevertInputSchema,
    workletCatalogUpdateInputSchema,
    type WorkletCatalog,
    type WorkletCatalogInstallInput,
    type WorkletCatalogMutationResult,
    type WorkletCatalogRevertInput,
    type WorkletCatalogUpdateInput,
} from "./WorkletStore.js";

export const WORKLET_TABLE = "happy_agent_module_worklets";
export const WORKLET_RECEIPTS_TABLE = "happy_agent_module_worklet_receipts";
export const WORKLET_PROOFS_TABLE = "happy_agent_module_worklet_proofs";
export const WORKLETS_MIGRATION_KEY = "001-worklets-catalog";
export const WORKLETS_DROP_REPLAY_EVIDENCE_MIGRATION_KEY =
    "002-worklets-drop-replay-evidence";

type JsonRow = { readonly value_json: string };
type DatabaseRoot = AgentDatabase & {
    transaction: <Result>(
        work: (database: AgentDatabaseFacade<AgentDatabase>) => Promise<Result>,
    ) => Promise<Result>;
};
export type WorkletDatabase = Omit<WorkletCatalog, "afterCommit" | "onRollback">;

export function createWorkletDatabase(): WorkletDatabase {
    const databaseFor = (ctx: Context): AgentDatabase => {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Worklets module requires an Agent Base database context.");
        }
        return database;
    };
    const transaction = async <Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> => {
        const kv = agentKV(ctx);
        if (kv !== undefined) {
            return await kv.transaction(ctx, async (_scope, txCtx) => await work(txCtx));
        }
        const root = databaseFor(ctx) as DatabaseRoot;
        if (typeof root.transaction !== "function") {
            return await work(ctx);
        }
        let drain: (() => Promise<void>) | undefined;
        const result = await root.transaction(async (database) => {
            const [commitCtx, runAfterCommit] = withAfterCommit(ctx);
            drain = runAfterCommit;
            return await work(withAgentDatabase(commitCtx, database));
        });
        await drain?.();
        return result;
    };

    const readJson = async <ValueType>(
        ctx: Context,
        query: ReturnType<typeof sql>,
        label: string,
        validate: (value: unknown) => asserts value is ValueType,
    ): Promise<ValueType | undefined> => {
        const row = (await agentDatabaseRows<JsonRow>(databaseFor(ctx), query))[0];
        if (row === undefined) return undefined;
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.value_json);
        } catch {
            throw new Error(`${label} contains invalid JSON.`);
        }
        validate(parsed);
        return structuredClone(parsed);
    };

    const get = async (ctx: Context, name: string): Promise<Worklet | undefined> =>
        await readJson(
            ctx,
            sql`SELECT worklet_json AS value_json
                FROM ${sql.raw(WORKLET_TABLE)}
                WHERE name = ${name}
                LIMIT 1`,
            "Worklet row",
            assertWorklet,
        );

    return {
        transaction,
        list: async (ctx, query) => {
            if (!Value.Check(workletListQuerySchema, query)) {
                throw new Error("Worklet list query is invalid.");
            }
            const limit = query.limit ?? Math.min(MAX_WORKLET_LIST_SIZE, 50);
            const requested = query.cursor ?? 0;
            const offset = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
            const rows = await agentDatabaseRows<JsonRow>(
                databaseFor(ctx),
                sql`SELECT worklet_json AS value_json
                    FROM ${sql.raw(WORKLET_TABLE)}
                    ORDER BY name
                    LIMIT ${limit + 1} OFFSET ${offset}`,
            );
            const selected = rows.slice(0, limit);
            const worklets: Worklet[] = [];
            for (const row of selected) {
                let value: unknown;
                try {
                    value = JSON.parse(row.value_json);
                } catch {
                    throw new Error("Worklet row contains invalid JSON.");
                }
                assertWorklet(value);
                worklets.push(structuredClone(value));
            }
            const nextCursor = rows.length > limit ? offset + worklets.length : undefined;
            const page = {
                worklets,
                limit,
                hasMore: nextCursor !== undefined,
                ...(offset > 0 ? { previousCursor: Math.max(0, offset - limit) } : {}),
                ...(nextCursor === undefined ? {} : { nextCursor }),
            };
            if (!Value.Check(workletListPageSchema, page)) {
                throw new Error("Worklet database returned an invalid page.");
            }
            return page;
        },
        get,
        install: async (ctx, input) => {
            if (!Value.Check(workletCatalogInstallInputSchema, input)) {
                throw new Error("Worklet install input is invalid.");
            }
            if ((await get(ctx, input.name)) !== undefined) {
                throw new Error(`Worklet "${input.name}" already exists.`);
            }
            const initial = input.initialVersion;
            const worklet: Worklet = {
                name: input.name,
                ownerAgentId: input.ownerAgentId,
                currentVersion: 1,
                operations: structuredClone(initial.operations),
                versions: [structuredClone(initial)],
                createdAt: initial.createdAt,
                updatedAt: initial.createdAt,
            };
            assertWorklet(worklet);
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(WORKLET_TABLE)} (name, worklet_json)
                    VALUES (${worklet.name}, ${JSON.stringify(worklet)})`,
            );
            const result: WorkletCatalogMutationResult = {
                operation: "install",
                name: worklet.name,
                operationId: input.operationId,
                targetVersion: 1,
                currentVersion: 1,
                changed: true,
                worklet,
            };
            assertWorkletMutation(result);
            return result;
        },
        update: async (ctx, name, input) => {
            if (
                !Value.Check(workletNameSchema, name) ||
                !Value.Check(workletCatalogUpdateInputSchema, input)
            ) {
                throw new Error("Worklet update input is invalid.");
            }
            const before = await get(ctx, name);
            if (before === undefined) throw new Error(`Worklet "${name}" was not found.`);
            const version = input.version;
            if (version !== before.versions.length + 1 || version > MAX_WORKLET_VERSIONS) {
                throw new Error("Worklet update version is not the next version.");
            }
            const nextVersion = {
                version,
                sourceRef: input.sourceRef,
                changeDescription: input.changeDescription,
                operations: structuredClone(input.operations),
                createdAt: input.createdAt,
                operationId: input.operationId,
            };
            if (!Value.Check(workletVersionSchema, nextVersion)) {
                throw new Error("Worklet update version is invalid.");
            }
            const worklet: Worklet = {
                ...before,
                currentVersion: version,
                operations: structuredClone(nextVersion.operations),
                versions: [...before.versions, nextVersion],
                updatedAt: input.createdAt,
            };
            assertWorklet(worklet);
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`UPDATE ${sql.raw(WORKLET_TABLE)}
                    SET worklet_json = ${JSON.stringify(worklet)}
                    WHERE name = ${name}`,
            );
            const result: WorkletCatalogMutationResult = {
                operation: "update",
                name,
                operationId: input.operationId,
                targetVersion: version,
                currentVersion: version,
                changed: true,
                worklet,
            };
            assertWorkletMutation(result);
            return result;
        },
        revert: async (ctx, name, input) => {
            if (
                !Value.Check(workletNameSchema, name) ||
                !Value.Check(workletCatalogRevertInputSchema, input)
            ) {
                throw new Error("Worklet revert input is invalid.");
            }
            const before = await get(ctx, name);
            if (before === undefined) throw new Error(`Worklet "${name}" was not found.`);
            if (!before.versions.some((version) => version.version === input.version)) {
                throw new Error(`Worklet version ${input.version} does not exist.`);
            }
            const changed = before.currentVersion !== input.version;
            const target = before.versions.find((version) => version.version === input.version)!;
            const worklet: Worklet = {
                ...before,
                currentVersion: input.version,
                operations: structuredClone(target.operations),
                updatedAt: before.updatedAt,
            };
            assertWorklet(worklet);
            if (changed) {
                await agentDatabaseRun(
                    databaseFor(ctx),
                    sql`UPDATE ${sql.raw(WORKLET_TABLE)}
                        SET worklet_json = ${JSON.stringify(worklet)}
                        WHERE name = ${name}`,
                );
            }
            const result: WorkletCatalogMutationResult = {
                operation: "revert",
                name,
                operationId: input.operationId,
                targetVersion: input.version,
                currentVersion: input.version,
                changed,
                worklet,
            };
            assertWorkletMutation(result);
            return result;
        },
        remove: async (ctx, name, operationId) => {
            if (
                !Value.Check(workletNameSchema, name) ||
                !Value.Check(workletAgentIdSchema, operationId)
            ) {
                throw new Error("Worklet remove input is invalid.");
            }
            const existing = await get(ctx, name);
            if (existing !== undefined) {
                await agentDatabaseRun(
                    databaseFor(ctx),
                    sql`DELETE FROM ${sql.raw(WORKLET_TABLE)} WHERE name = ${name}`,
                );
            }
            const result: WorkletCatalogMutationResult = {
                operation: "remove",
                name,
                operationId,
                targetVersion: 0,
                currentVersion: 0,
                changed: existing !== undefined,
                removed: existing !== undefined,
            };
            assertWorkletMutation(result);
            return result;
        },
    };
}