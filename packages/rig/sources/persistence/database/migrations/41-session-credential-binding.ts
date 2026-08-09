import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * Keeps the immutable credential identity separate from its session-visible provider ID.
 *
 * Existing sessions predate shared extras and therefore belong to their session owner/provider
 * tuple. A separate table avoids adding an invalid default to the sessions table.
 */
export async function sessionCredentialBinding(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS session_credential_bindings (
                session_id TEXT PRIMARY KEY NOT NULL
                    REFERENCES sessions(id) ON DELETE CASCADE,
                binding_id TEXT NOT NULL
            )
        `),
    );
    const sessions = (
        await database.all<{ name: string }>(
            sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
        )
    )[0];
    if (sessions === undefined) return;
    await database.run(
        sql.raw(`
            INSERT OR IGNORE INTO session_credential_bindings (session_id, binding_id)
            SELECT id, owner_instance_id || ':' || provider_id
            FROM sessions
        `),
    );
}
