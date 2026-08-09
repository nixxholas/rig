import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * Lifetime usage starts from the exact committed total already stored for each session. Future
 * resets preserve this column even while resetting the conversation-scoped usage envelope.
 */
export async function agentTreeUsage(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        ALTER TABLE sessions
        ADD COLUMN lifetime_total_tokens INTEGER NOT NULL DEFAULT 0
    `),
    );
    await database.run(
        sql.raw(`
        UPDATE sessions
        SET lifetime_total_tokens = CASE
            WHEN json_valid(usage_json) THEN CASE
                WHEN json_type(
                    usage_json,
                    '$.committed.totalTokens'
                ) IN ('integer', 'real')
                    THEN MAX(0, CAST(json_extract(
                        usage_json,
                        '$.committed.totalTokens'
                    ) AS INTEGER))
                ELSE 0
            END
            ELSE 0
        END
    `),
    );
    await database.run(
        sql.raw(`
        CREATE INDEX sessions_delegated_created
        ON sessions(delegated_by_session_id, created_at_ms, id)
    `),
    );
}
