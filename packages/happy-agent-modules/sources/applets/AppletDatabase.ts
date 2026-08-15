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
import { Value } from "@sinclair/typebox/value";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";

import {
    appletCatalogCreateInputSchema,
    appletCatalogRevertInputSchema,
    appletCatalogUpdateInputSchema,
    assertApplet,
    assertAppletMutation,
    type AppletCatalog,
    type AppletCatalogMutationResult,
} from "./AppletStore.js";
import {
    MAX_APPLET_LIST_SIZE,
    MAX_APPLET_VERSIONS,
    appletListPageSchema,
    appletListQuerySchema,
    appletNameSchema,
    appletRefSchema,
    appletVersionSchema,
    type Applet,
} from "./Applet.js";

export const APPLET_TABLE = "happy_agent_module_applets";
export const APPLET_RECEIPTS_TABLE = "happy_agent_module_applet_receipts";
export const APPLET_PROOFS_TABLE = "happy_agent_module_applet_proofs";
export const APPLETS_MIGRATION_KEY = "001-applets-catalog";
export const APPLETS_REMOVE_IDEMPOTENCY_MIGRATION_KEY = "002-remove-applet-idempotency";

type JsonRow = { readonly value_json: string };
type DatabaseRoot = AgentDatabase & {
    transaction: <Result>(
        work: (database: AgentDatabaseFacade<AgentDatabase>) => Promise<Result>,
    ) => Promise<Result>;
};
export type AppletDatabase = Omit<AppletCatalog, "afterCommit" | "onRollback">;

/**
 * The applet database is a thin SQL view owned by the applet module. It keeps
 * the module's semantic operation surface while all durable state lives in
 * module tables.
 */
export function createAppletDatabase(): AppletDatabase {
    const databaseFor = (ctx: Context): AgentDatabase => {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Applets module requires an Agent Base database context.");
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

    const read = async <Value>(
        ctx: Context,
        query: ReturnType<typeof sql>,
        label: string,
        validate: (value: unknown) => asserts value is Value,
    ): Promise<Value | undefined> => {
        const row = (
            await agentDatabaseRows<JsonRow>(databaseFor(ctx), query)
        )[0];
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

    const get = async (ctx: Context, name: string): Promise<Applet | undefined> =>
        await read(
            ctx,
            sql`SELECT applet_json AS value_json
                FROM ${sql.raw(APPLET_TABLE)}
                WHERE name = ${name}
                LIMIT 1`,
            "Applet row",
            assertApplet,
        );

    return {
        transaction,
        list: async (ctx, query) => {
            if (!ValueCheck(appletListQuerySchema, query)) {
                throw new Error("Applet list query is invalid.");
            }
            const limit = query.limit ?? Math.min(MAX_APPLET_LIST_SIZE, 50);
            const offset =
                query.cursor === undefined
                    ? 0
                    : /^(?:0|[1-9][0-9]*)$/u.test(query.cursor)
                      ? Number(query.cursor)
                      : Number.NaN;
            if (!Number.isSafeInteger(offset)) {
                throw new Error("Applet list cursor is invalid.");
            }
            const rows = await agentDatabaseRows<JsonRow>(
                databaseFor(ctx),
                sql`SELECT applet_json AS value_json
                    FROM ${sql.raw(APPLET_TABLE)}
                    ORDER BY name
                    LIMIT ${limit + 1} OFFSET ${offset}`,
            );
            const selected = rows.slice(0, limit);
            const applets: Applet[] = [];
            for (const row of selected) {
                let value: unknown;
                try {
                    value = JSON.parse(row.value_json);
                } catch {
                    throw new Error("Applet row contains invalid JSON.");
                }
                assertApplet(value);
                applets.push(structuredClone(value));
            }
            const hasMore = rows.length > limit;
            const nextCursor = hasMore ? String(offset + applets.length) : undefined;
            const page =
                nextCursor === undefined
                    ? { applets, limit, hasMore: false as const }
                    : { applets, limit, hasMore: true as const, nextCursor };
            if (!ValueCheck(appletListPageSchema, page)) {
                throw new Error("Applet database returned an invalid page.");
            }
            return page;
        },
        get,
        create: async (ctx, input) => {
            if (!ValueCheck(appletCatalogCreateInputSchema, input)) {
                throw new Error("Applet create input is invalid.");
            }
            if ((await get(ctx, input.name)) !== undefined) {
                throw new Error(`Applet "${input.name}" already exists.`);
            }
            const initial = input.initialVersion;
            const applet: Applet = {
                name: input.name,
                description: input.description,
                purpose: input.purpose,
                authorSessionId: input.authorSessionId,
                allowedScopes: input.allowedScopes ?? ["global"],
                ...(input.sourceDescription === undefined
                    ? {}
                    : { sourceDescription: input.sourceDescription }),
                ...(input.iconThumbhash === undefined
                    ? {}
                    : { iconThumbhash: input.iconThumbhash }),
                ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
                currentVersion: 1,
                versions: [structuredClone(initial)],
                createdAt: initial.createdAt,
                updatedAt: initial.createdAt,
            };
            assertApplet(applet);
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(APPLET_TABLE)} (name, applet_json)
                    VALUES (${applet.name}, ${JSON.stringify(applet)})`,
            );
            const result: AppletCatalogMutationResult = {
                operation: "create",
                name: applet.name,
                operationId: input.operationId,
                targetVersion: 1,
                currentVersion: 1,
                changed: true,
                applet,
            };
            assertAppletMutation(result);
            return result;
        },
        update: async (ctx, name, input) => {
            if (
                !ValueCheck(appletNameSchema, name) ||
                !ValueCheck(appletCatalogUpdateInputSchema, input)
            ) {
                throw new Error("Applet update input is invalid.");
            }
            const before = await get(ctx, name);
            if (before === undefined) throw new Error(`Applet "${name}" was not found.`);
            if (input.version !== before.versions.length + 1 || input.version > MAX_APPLET_VERSIONS) {
                throw new Error("Applet update version is not the next version.");
            }
            const version = {
                version: input.version,
                changeDescription: input.changeDescription,
                createdAt: input.createdAt,
                operationId: input.operationId,
            };
            if (!ValueCheck(appletVersionSchema, version)) {
                throw new Error("Applet update version is invalid.");
            }
            const applet: Applet = {
                ...before,
                ...(input.allowedScopes === undefined ? {} : { allowedScopes: input.allowedScopes }),
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                ...(input.sourceDescription === undefined
                    ? {}
                    : { sourceDescription: input.sourceDescription }),
                ...(input.iconThumbhash === undefined
                    ? {}
                    : { iconThumbhash: input.iconThumbhash }),
                ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
                currentVersion: input.version,
                versions: [...before.versions, version],
                updatedAt: input.createdAt,
            };
            assertApplet(applet);
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`UPDATE ${sql.raw(APPLET_TABLE)}
                    SET applet_json = ${JSON.stringify(applet)}
                    WHERE name = ${name}`,
            );
            const result: AppletCatalogMutationResult = {
                operation: "update",
                name,
                operationId: input.operationId,
                targetVersion: input.version,
                currentVersion: applet.currentVersion,
                changed: true,
                applet,
            };
            assertAppletMutation(result);
            return result;
        },
        revert: async (ctx, name, input) => {
            if (
                !ValueCheck(appletNameSchema, name) ||
                !ValueCheck(appletCatalogRevertInputSchema, input)
            ) {
                throw new Error("Applet revert input is invalid.");
            }
            const before = await get(ctx, name);
            if (before === undefined) throw new Error(`Applet "${name}" was not found.`);
            if (!before.versions.some((version) => version.version === input.version)) {
                throw new Error(`Applet version ${input.version} does not exist.`);
            }
            const changed = before.currentVersion !== input.version;
            const applet: Applet = {
                ...before,
                currentVersion: input.version,
                updatedAt: changed ? Math.max(before.updatedAt, Date.now()) : before.updatedAt,
            };
            assertApplet(applet);
            if (changed) {
                await agentDatabaseRun(
                    databaseFor(ctx),
                    sql`UPDATE ${sql.raw(APPLET_TABLE)}
                        SET applet_json = ${JSON.stringify(applet)}
                        WHERE name = ${name}`,
                );
            }
            const result: AppletCatalogMutationResult = {
                operation: "revert",
                name,
                operationId: input.operationId,
                targetVersion: input.version,
                currentVersion: applet.currentVersion,
                changed,
                applet,
            };
            assertAppletMutation(result);
            return result;
        },
        remove: async (ctx, name, operationId) => {
            if (!ValueCheck(appletNameSchema, name) || !ValueCheck(appletRefSchema, operationId)) {
                throw new Error("Applet remove input is invalid.");
            }
            const existing = await get(ctx, name);
            if (existing !== undefined) {
                await agentDatabaseRun(
                    databaseFor(ctx),
                    sql`DELETE FROM ${sql.raw(APPLET_TABLE)} WHERE name = ${name}`,
                );
            }
            const result: AppletCatalogMutationResult = {
                operation: "remove",
                name,
                operationId,
                targetVersion: 0,
                currentVersion: 0,
                changed: existing !== undefined,
                removed: existing !== undefined,
                ...(existing === undefined ? {} : { applet: existing }),
            };
            assertAppletMutation(result);
            return result;
        },
        current: async (ctx, name) => {
            const applet = await get(ctx, name);
            if (applet === undefined) return undefined;
            const version = applet.versions.find(
                (candidate) => candidate.version === applet.currentVersion,
            );
            return version === undefined ? undefined : structuredClone(version);
        },
    };
}

function ValueCheck(schema: unknown, value: unknown): boolean {
    // Keep the helper local so the database adapter's public surface remains
    // structural while avoiding a second runtime-validation implementation.
    return Value.Check(schema as Parameters<typeof Value.Check>[0], value);
}