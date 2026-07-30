import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function querySessionIdByAgentId(tx: TX, agentId: string): string | undefined {
    const rows = tx.all<Record<string, unknown>>(sql`
        SELECT id FROM sessions WHERE agent_id = ${agentId} LIMIT 2
    `);
    return rows.length === 1 ? readString(rows[0]!, "id") : undefined;
}
