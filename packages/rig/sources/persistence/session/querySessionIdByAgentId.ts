import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { readString } from "./impl/sqliteRow.js";

export async function querySessionIdByAgentId(
    ctx: Context,
    agentId: string,
): Promise<string | undefined> {
    return await inDatabase(ctx, "rig.sql.session.query_session_id_by_agent_id", async (ctx) => {
        const tx = ctx.tx;
        const rows = await tx.all<Record<string, unknown>>(sql`
        SELECT id FROM sessions WHERE agent_id = ${agentId} LIMIT 2
    `);
        return rows.length === 1 ? readString(rows[0]!, "id") : undefined;
    });
}
