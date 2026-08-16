import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

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
    defaultAppletAllowedScopes,
    type Applet,
} from "./Applet.js";

export const APPLET_TABLE = "happy_agent_module_applets";
export const APPLET_RECEIPTS_TABLE = "happy_agent_module_applet_receipts";
export const APPLET_PROOFS_TABLE = "happy_agent_module_applet_proofs";
export const APPLETS_MIGRATION_KEY = "001-applets-catalog";
export const APPLETS_REMOVE_IDEMPOTENCY_MIGRATION_KEY = "002-remove-applet-idempotency";

type JsonRow = { readonly value_json: string };
export type AppletDatabase = AppletCatalog;

/**
 * The applet database is a thin SQL view owned by the applet module. It keeps
 * the module's semantic operation surface while all durable state lives in
 * module tables.
 */
export function createAppletDatabase(): AppletDatabase {
    const read = async <Value>(
        ctx: Context,
        query: ReturnType<typeof sql>,
        label: string,
        validate: (value: unknown) => asserts value is Value,
    ): Promise<Value | undefined> => {
        const row = (await agentDatabaseRows<JsonRow>(ctx.db, query))[0];
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
                ctx.db,
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
        lock: async (ctx, name) => {
            if (!ValueCheck(appletNameSchema, name)) {
                throw new Error("Applet lock name is invalid.");
            }
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(APPLET_TABLE)}
                    SET applet_json = applet_json
                    WHERE name = ${name}`,
            );
            const applet = await get(ctx, name);
            if (applet === undefined) {
                throw new Error(`Applet "${name}" was not found.`);
            }
            return applet;
        },
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
                allowedScopes: input.allowedScopes ?? [...defaultAppletAllowedScopes],
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
                ctx.db,
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
            let before = await get(ctx, name);
            if (before === undefined) throw new Error(`Applet "${name}" was not found.`);
            for (let attempt = 0; attempt < 16; attempt += 1) {
                const targetVersion = before.versions.length + 1;
                if (targetVersion > MAX_APPLET_VERSIONS) {
                    throw new Error("Applet has reached the maximum version count.");
                }
                const version = {
                    version: targetVersion,
                    changeDescription: input.changeDescription,
                    createdAt: input.createdAt,
                    operationId: input.operationId,
                };
                if (!ValueCheck(appletVersionSchema, version)) {
                    throw new Error("Applet update version is invalid.");
                }
                const applet: Applet = {
                    ...before,
                    ...(input.allowedScopes === undefined
                        ? {}
                        : { allowedScopes: input.allowedScopes }),
                    ...(input.description === undefined ? {} : { description: input.description }),
                    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                    ...(input.sourceDescription === undefined
                        ? {}
                        : { sourceDescription: input.sourceDescription }),
                    currentVersion: targetVersion,
                    versions: [...before.versions, version],
                    updatedAt: input.createdAt,
                };
                assertApplet(applet);
                // Compare-and-swap keeps this portable across SQLite and PostgreSQL while
                // preserving correctness when two callers share one transaction context.
                const rows = await agentDatabaseRows<JsonRow>(
                    ctx.db,
                    sql`UPDATE ${sql.raw(APPLET_TABLE)}
                        SET applet_json = ${JSON.stringify(applet)}
                        WHERE name = ${name}
                          AND applet_json = ${JSON.stringify(before)}
                        RETURNING applet_json AS value_json`,
                );
                const row = rows[0];
                if (row === undefined) {
                    const current = await get(ctx, name);
                    if (current === undefined) {
                        throw new Error(`Applet "${name}" disappeared during update.`);
                    }
                    before = current;
                    continue;
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(row.value_json);
                } catch {
                    throw new Error("Applet update returned invalid JSON.");
                }
                assertApplet(parsed);
                const committed = structuredClone(parsed);
                const appended = committed.versions[committed.versions.length - 1];
                if (appended === undefined) {
                    throw new Error("Applet update did not append a version.");
                }
                const result: AppletCatalogMutationResult = {
                    operation: "update",
                    name,
                    operationId: input.operationId,
                    targetVersion: appended.version,
                    currentVersion: committed.currentVersion,
                    changed: true,
                    applet: committed,
                };
                assertAppletMutation(result);
                return result;
            }
            throw new Error("Applet update conflicted with too many concurrent changes.");
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
                    ctx.db,
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
                    ctx.db,
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
