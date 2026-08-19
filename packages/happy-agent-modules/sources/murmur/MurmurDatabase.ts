import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { murmurProfileBindingSchema, type MurmurProfileBinding } from "./MurmurTypes.js";

export const MURMUR_BINDING_MIGRATION_KEY = "001-murmur-binding";
export const MURMUR_STORE_MIGRATION_KEY = "002-murmur-store";

const BINDING_TABLE = "happy_agent_murmur_binding";

/** Where Murmur's own cryptographic state lives. The store class is its only reader. */
export const MURMUR_STORE_TABLE = "happy_agent_murmur_store";

export const murmurMigrations: readonly AgentModuleMigration[] = [
    [
        MURMUR_BINDING_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(BINDING_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    binding_json TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        MURMUR_STORE_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(MURMUR_STORE_TABLE)} (
                    key TEXT NOT NULL PRIMARY KEY,
                    value_base64 TEXT NOT NULL
                )`,
            );
        },
    ],
];

/** Reads the one binding this installation has, or nothing when sharing was never bound. */
export async function readMurmurBinding(ctx: Context): Promise<MurmurProfileBinding | undefined> {
    const rows = await agentDatabaseRows<{ binding_json: string }>(
        ctx.db,
        sql`SELECT binding_json FROM ${sql.raw(BINDING_TABLE)} WHERE singleton_id = 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(row.binding_json);
    } catch (error: unknown) {
        throw new Error("The stored sharing profile binding is not readable.", { cause: error });
    }
    if (!Value.Check(murmurProfileBindingSchema, value)) {
        throw new Error("The stored sharing profile binding is invalid.");
    }
    return structuredClone(value) as MurmurProfileBinding;
}

/**
 * Binds this installation's Murmur identity to one person, or confirms it already is.
 *
 * A Murmur identity means "this person" to everyone who has accepted it as a contact, so it may
 * never quietly come to mean someone else. Binding a second profile, or presenting a different
 * identity for the bound profile, is refused rather than overwritten. The one move that is
 * allowed is filling in an identity that was deliberately cleared by a reset.
 */
export async function bindMurmurProfile(
    ctx: Context,
    profileId: string,
    murmurIdentity: string,
    createdAt: number,
): Promise<"created" | "unchanged"> {
    return await ctx.inTx(async (txCtx) => {
        const current = await readMurmurBinding(txCtx);
        if (current !== undefined) {
            if (current.profileId !== profileId) {
                throw new Error("This Murmur identity is already bound to another profile.");
            }
            if (current.murmurIdentity !== null && current.murmurIdentity !== murmurIdentity) {
                throw new Error("The stored Murmur identity does not match this sharing profile.");
            }
            if (current.murmurIdentity === null) {
                await writeMurmurBinding(txCtx, { ...current, murmurIdentity });
            }
            return "unchanged";
        }
        await writeMurmurBinding(txCtx, { createdAt, murmurIdentity, profileId });
        return "created";
    });
}

/**
 * Throws away everything Murmur knows, while keeping the person it knew it as.
 *
 * The cryptographic state and the row naming the identity it belongs to now live in the same
 * database, so both go in one transaction: an interrupted reset can no longer leave a record of
 * an identity whose keys are gone, or keys nothing claims. Clearing the identity is what lets the
 * freshly opened client bind its new one to the same person instead of being refused as an
 * impostor.
 */
export async function discardMurmurIdentity(ctx: Context): Promise<void> {
    await ctx.inTx(async (txCtx) => {
        await agentDatabaseRun(txCtx.db, sql`DELETE FROM ${sql.raw(MURMUR_STORE_TABLE)}`);
        const current = await readMurmurBinding(txCtx);
        if (current === undefined) return;
        await writeMurmurBinding(txCtx, { ...current, murmurIdentity: null });
    });
}

async function writeMurmurBinding(ctx: Context, binding: MurmurProfileBinding): Promise<void> {
    if (!Value.Check(murmurProfileBindingSchema, binding)) {
        throw new Error("Sharing received an invalid profile binding.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BINDING_TABLE)} (singleton_id, binding_json)
            VALUES (1, ${JSON.stringify(binding)})
            ON CONFLICT (singleton_id)
            DO UPDATE SET binding_json = EXCLUDED.binding_json`,
    );
}
