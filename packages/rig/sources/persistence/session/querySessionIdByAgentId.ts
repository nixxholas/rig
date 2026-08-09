import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export async function querySessionIdByAgentId(
    tx: DatabaseScope,
    agentId: string,
): Promise<string | undefined> {
    return await inDatabase(tx, async (tx) => {
        const rows = await tx.all<Record<string, unknown>>(sql`
        SELECT id FROM sessions WHERE agent_id = ${agentId} LIMIT 2
    `);
        return rows.length === 1 ? readString(rows[0]!, "id") : undefined;
    });
}
