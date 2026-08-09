import { sql } from "drizzle-orm";

import { MAX_AGENT_TREE_USAGE_SESSIONS } from "../../agent/context/AgentTreeUsageContext.js";
import type { DatabaseScope } from "../Transaction.js";
import { inDatabase } from "../database/inDatabase.js";
import { readString } from "./impl/sqliteRow.js";

/**
 * Finds every durable session connected through subagent or workspace delegation edges.
 *
 * Restoring the complete tree keeps synchronous runtime tools backed by the same bounded tree as
 * the durable usage query, including delegated sessions whose own root ID differs from the caller.
 */
export async function queryAgentTreeSessionIds(
    tx: DatabaseScope,
    rootSessionId: string,
): Promise<readonly string[]> {
    return await inDatabase(tx, async (tx) => {
        const rows = await tx.all<Record<string, unknown>>(sql`
            WITH RECURSIVE descendants(id) AS (
                SELECT id
                FROM sessions
                WHERE id = ${rootSessionId}
                UNION
                SELECT child.id
                FROM sessions child INDEXED BY sessions_parent_created
                JOIN descendants parent
                    ON child.parent_session_id = parent.id
                UNION
                SELECT child.id
                FROM sessions child INDEXED BY sessions_delegated_created
                JOIN descendants parent
                    ON child.delegated_by_session_id = parent.id
                LIMIT ${MAX_AGENT_TREE_USAGE_SESSIONS + 1}
            )
            SELECT id
            FROM sessions
            WHERE id IN descendants
            ORDER BY
                CASE WHEN id = ${rootSessionId} THEN 0 ELSE 1 END,
                created_at_ms ASC,
                id ASC
        `);
        if (rows.length > MAX_AGENT_TREE_USAGE_SESSIONS) {
            throw new Error(
                `Agent trees are limited to ${MAX_AGENT_TREE_USAGE_SESSIONS.toLocaleString("en-US")} sessions.`,
            );
        }
        return rows.map((row) => readString(row, "id"));
    });
}
