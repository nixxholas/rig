import {
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
    type AgentStorageTransaction,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    secretEnvironmentVariableNameSchema,
    secretHostEnvironmentSchema,
    secretPageSchema,
    secretReferenceSchema,
    type SecretAgentId,
    type SecretAttachInput,
    type SecretAttachment,
    type SecretHostEnvironment,
    type SecretListQuery,
    type SecretPage,
    type SecretReference,
    type SecretRegistration,
    type SecretUpdateInput,
} from "./Secret.js";
import {
    type SecretStoreAttachResult,
    type SecretStoreDetachResult,
    type SecretStoreRegisterResult,
    type SecretStoreRemoveResult,
    type SecretStoreUpdateResult,
} from "./SecretStore.js";

export const SECRETS_MIGRATION_KEY = "001-secrets";

const SECRETS_TABLE = "happy_agent_secrets";
const ATTACHMENTS_TABLE = "happy_agent_secret_attachments";

export const secretsMigrations: readonly AgentModuleMigration[] = [
    [
        SECRETS_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_secrets (
                    owner_agent_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    description TEXT NOT NULL,
                    environment_json TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    available_to_model INTEGER,
                    kind TEXT,
                    PRIMARY KEY (owner_agent_id, id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_secret_attachments (
                    owner_agent_id TEXT NOT NULL,
                    scope_ref TEXT NOT NULL,
                    secret_id TEXT NOT NULL,
                    PRIMARY KEY (owner_agent_id, scope_ref, secret_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_secrets_owner
                    ON happy_agent_secrets(owner_agent_id, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_secret_attachments_scope
                    ON happy_agent_secret_attachments(owner_agent_id, scope_ref, secret_id)`,
            );
        },
    ],
];

export interface SecretDatabase {
    readonly transaction: <Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ) => Promise<Result>;
    readonly list: (
        ctx: Context,
        agentId: SecretAgentId,
        query: SecretListQuery,
    ) => Promise<SecretPage>;
    readonly reference: (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
    ) => Promise<SecretReference | undefined>;
    readonly attachment: (
        ctx: Context,
        agentId: SecretAgentId,
        input: SecretAttachInput,
    ) => Promise<SecretAttachment | undefined>;
    readonly register: (
        ctx: Context,
        agentId: SecretAgentId,
        registration: SecretRegistration,
    ) => Promise<SecretStoreRegisterResult>;
    readonly update: (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
        input: SecretUpdateInput,
    ) => Promise<SecretStoreUpdateResult>;
    readonly remove: (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
    ) => Promise<SecretStoreRemoveResult>;
    readonly attach: (
        ctx: Context,
        agentId: SecretAgentId,
        input: SecretAttachInput,
    ) => Promise<SecretStoreAttachResult>;
    readonly detach: (
        ctx: Context,
        agentId: SecretAgentId,
        input: SecretAttachInput,
    ) => Promise<SecretStoreDetachResult>;
    readonly resolveForHost: (
        ctx: Context,
        agentId: SecretAgentId,
        scopeRef: string,
        secretIds?: readonly string[],
    ) => Promise<SecretHostEnvironment>;
}

export function createSecretDatabase(
    transaction?: AgentStorageTransaction,
): SecretDatabase {
    const dbFor = (ctx: Context): AgentDatabase => {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Secrets module requires an Agent Base database context.");
        }
        return database;
    };
    const databaseFor = (ctx: Context): AgentDatabase => dbFor(ctx);
    const runTransaction = async <Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> => {
        if (transaction === undefined) return await work(ctx);
        return await transaction(ctx, async (transactionCtx) => work(transactionCtx));
    };

    const rowReference = (row: SecretRow): SecretReference => {
        const environment = parseEnvironment(row.environment_json);
        const reference = {
            id: row.id,
            description: row.description,
            environmentVariables: Object.keys(environment).sort((left, right) =>
                left.localeCompare(right),
            ),
            revision: row.revision,
            ...(row.available_to_model === null
                ? {}
                : { availableToModel: Number(row.available_to_model) !== 0 }),
            ...(row.kind === null ? {} : { kind: row.kind }),
        };
        if (!Value.Check(secretReferenceSchema, reference)) {
            throw new Error("Secrets database contains an invalid reference.");
        }
        return structuredClone(reference);
    };

    const rowFor = async (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
    ): Promise<SecretRow | undefined> => {
        const rows = await agentDatabaseRows<SecretRow>(
            databaseFor(ctx),
            sql`SELECT owner_agent_id, id, description, environment_json, revision,
                       available_to_model, kind
                FROM ${sql.raw(SECRETS_TABLE)}
                WHERE owner_agent_id = ${agentId} AND id = ${secretId}
                LIMIT 1`,
        );
        return rows[0];
    };

    return {
        transaction: runTransaction,
        list: async (ctx, agentId, query) => {
            const cursor = query.cursor ?? 0;
            const clauses = [sql`owner_agent_id = ${agentId}`];
            if (query.scopeRef !== undefined) {
                clauses.push(
                    sql`EXISTS (
                        SELECT 1 FROM ${sql.raw(ATTACHMENTS_TABLE)} a
                        WHERE a.owner_agent_id = ${agentId}
                          AND a.scope_ref = ${query.scopeRef}
                          AND a.secret_id = s.id
                    )`,
                );
            }
            const rows = await agentDatabaseRows<SecretRow>(
                databaseFor(ctx),
                sql`SELECT s.owner_agent_id, s.id, s.description, s.environment_json,
                           s.revision, s.available_to_model, s.kind
                    FROM ${sql.raw(SECRETS_TABLE)} s
                    WHERE ${sql.join(clauses, sql` AND `)}
                    ORDER BY s.id
                    LIMIT ${query.limit} OFFSET ${cursor}`,
            );
            const secrets = rows.map(rowReference);
            const page = {
                secrets,
                limit: query.limit,
                ...(rows.length === query.limit ? { nextCursor: cursor + rows.length } : {}),
            };
            if (!Value.Check(secretPageSchema, page)) {
                throw new Error("Secrets database produced an invalid page.");
            }
            return page;
        },
        reference: async (ctx, agentId, secretId) => {
            const row = await rowFor(ctx, agentId, secretId);
            return row === undefined ? undefined : rowReference(row);
        },
        attachment: async (ctx, agentId, input) => {
            const rows = await agentDatabaseRows<{ secret_id: string }>(
                databaseFor(ctx),
                sql`SELECT secret_id FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId}
                      AND scope_ref = ${input.scopeRef}
                      AND secret_id = ${input.secretId}
                    LIMIT 1`,
            );
            return rows.length === 0 ? undefined : structuredClone(input);
        },
        register: async (ctx, agentId, registration) => {
            const previous = await rowFor(ctx, agentId, registration.id);
            const existingEnvironment =
                previous === undefined ? undefined : parseEnvironment(previous.environment_json);
            const changed =
                previous === undefined ||
                previous.description !== registration.description ||
                JSON.stringify(existingEnvironment) !== JSON.stringify(registration.environment);
            const revision =
                previous === undefined
                    ? "1"
                    : changed &&
                        JSON.stringify(existingEnvironment) !==
                            JSON.stringify(registration.environment)
                      ? incrementRevision(previous.revision)
                      : previous.revision;
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(SECRETS_TABLE)}
                    (owner_agent_id, id, description, environment_json, revision,
                     available_to_model, kind)
                    VALUES (
                        ${agentId}, ${registration.id}, ${registration.description},
                        ${JSON.stringify(registration.environment)}, ${revision}, ${null}, ${null}
                    )
                    ON CONFLICT (owner_agent_id, id) DO UPDATE SET
                        description = EXCLUDED.description,
                        environment_json = EXCLUDED.environment_json,
                        revision = EXCLUDED.revision`,
            );
            const row = await rowFor(ctx, agentId, registration.id);
            if (row === undefined)
                throw new Error("Secrets database did not persist registration.");
            return {
                operation: "register",
                changed,
                reference: rowReference(row),
            };
        },
        update: async (ctx, agentId, secretId, input) => {
            const previous = await rowFor(ctx, agentId, secretId);
            if (previous === undefined) {
                return { operation: "update", changed: false, secretId };
            }
            const environment = parseEnvironment(previous.environment_json);
            let environmentChanged = false;
            for (const [name, value] of Object.entries(input.environment ?? {})) {
                if (value === null) {
                    if (Object.hasOwn(environment, name)) {
                        delete environment[name];
                        environmentChanged = true;
                    }
                } else if (environment[name] !== value) {
                    environment[name] = value;
                    environmentChanged = true;
                }
            }
            const description = input.description ?? previous.description;
            const changed = description !== previous.description || environmentChanged;
            const revision = environmentChanged
                ? incrementRevision(previous.revision)
                : previous.revision;
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`UPDATE ${sql.raw(SECRETS_TABLE)}
                    SET description = ${description},
                        environment_json = ${JSON.stringify(environment)},
                        revision = ${revision}
                    WHERE owner_agent_id = ${agentId} AND id = ${secretId}`,
            );
            const row = await rowFor(ctx, agentId, secretId);
            if (row === undefined) throw new Error("Secrets database lost updated secret.");
            return {
                operation: "update",
                changed,
                secretId,
                reference: rowReference(row),
            };
        },
        remove: async (ctx, agentId, secretId) => {
            const previous = await rowFor(ctx, agentId, secretId);
            if (previous === undefined) return { operation: "remove", removed: false, secretId };
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId} AND secret_id = ${secretId}`,
            );
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`DELETE FROM ${sql.raw(SECRETS_TABLE)}
                    WHERE owner_agent_id = ${agentId} AND id = ${secretId}`,
            );
            return {
                operation: "remove",
                removed: true,
                secretId,
                reference: rowReference(previous),
            };
        },
        attach: async (ctx, agentId, input) => {
            const reference = await rowFor(ctx, agentId, input.secretId);
            if (reference === undefined) {
                throw new Error("The secret reference does not exist.");
            }
            const existing = await agentDatabaseRows<{ secret_id: string }>(
                databaseFor(ctx),
                sql`SELECT secret_id FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId}
                      AND scope_ref = ${input.scopeRef}
                      AND secret_id = ${input.secretId}
                    LIMIT 1`,
            );
            await agentDatabaseRun(
                databaseFor(ctx),
                sql`INSERT INTO ${sql.raw(ATTACHMENTS_TABLE)}
                    (owner_agent_id, scope_ref, secret_id)
                    VALUES (${agentId}, ${input.scopeRef}, ${input.secretId})
                    ON CONFLICT (owner_agent_id, scope_ref, secret_id) DO NOTHING`,
            );
            const attachment = structuredClone(input);
            return {
                operation: "attach",
                changed: existing.length === 0,
                attachment,
                reference: rowReference(reference),
            };
        },
        detach: async (ctx, agentId, input) => {
            const rows = await agentDatabaseRows<{ secret_id: string }>(
                databaseFor(ctx),
                sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId}
                      AND scope_ref = ${input.scopeRef}
                      AND secret_id = ${input.secretId}
                    RETURNING secret_id`,
            );
            return rows.length === 0
                ? { operation: "detach", detached: false }
                : { operation: "detach", detached: true, attachment: structuredClone(input) };
        },
        resolveForHost: async (ctx, agentId, scopeRef, secretIds) => {
            const clauses = [sql`a.owner_agent_id = ${agentId}`, sql`a.scope_ref = ${scopeRef}`];
            if (secretIds !== undefined) {
                if (secretIds.length === 0) return {};
                clauses.push(
                    sql`a.secret_id IN (${sql.join(
                        secretIds.map((id) => sql`${id}`),
                        sql`, `,
                    )})`,
                );
            }
            const rows = await agentDatabaseRows<{ environment_json: string }>(
                databaseFor(ctx),
                sql`SELECT s.environment_json
                    FROM ${sql.raw(ATTACHMENTS_TABLE)} a
                    JOIN ${sql.raw(SECRETS_TABLE)} s
                      ON s.owner_agent_id = a.owner_agent_id AND s.id = a.secret_id
                    WHERE ${sql.join(clauses, sql` AND `)}
                    ORDER BY a.secret_id`,
            );
            const environment: Record<string, string> = {};
            for (const row of rows)
                Object.assign(environment, parseEnvironment(row.environment_json));
            if (!Value.Check(secretHostEnvironmentSchema, environment)) {
                throw new Error("Secrets database produced an invalid host environment.");
            }
            return structuredClone(environment);
        },
    };
}

interface SecretRow {
    readonly owner_agent_id: string;
    readonly id: string;
    readonly description: string;
    readonly environment_json: string;
    readonly revision: string;
    readonly available_to_model: number | string | null;
    readonly kind: string | null;
}

function parseEnvironment(value: string): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error("Secrets database contains invalid environment JSON.");
    }
    const schema = Type.Record(
        secretEnvironmentVariableNameSchema,
        Type.String({ maxLength: 65_536 }),
        { additionalProperties: false, maxProperties: 256 },
    );
    if (!Value.Check(schema, parsed)) {
        throw new Error("Secrets database contains an invalid environment.");
    }
    return structuredClone(parsed) as Record<string, string>;
}

function incrementRevision(value: string): string {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? String(number + 1) : `${value}:next`;
}
