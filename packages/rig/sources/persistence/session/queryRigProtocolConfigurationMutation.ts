import type { Context } from "@steve.kite/stdlib";

import { sql } from "drizzle-orm";

import { inDatabase } from "../database/inDatabase.js";

export async function queryRigProtocolConfigurationMutation(
    ctx: Context,
    conversationId: string,
    mutationId: string,
): Promise<boolean> {
    return await inDatabase(
        ctx,
        "rig.sql.session.query_protocol_configuration_mutation",
        async (ctx) =>
            (
                await ctx.tx.all(sql`
                    SELECT 1
                    FROM session_events
                    WHERE session_id = ${conversationId}
                      AND type IN (
                          'session_configuration_changed',
                          'permission_mode_changed'
                      )
                      AND json_extract(data_json, '$.mutationId') = ${mutationId}
                    LIMIT 1
                `)
            ).length > 0,
    );
}
