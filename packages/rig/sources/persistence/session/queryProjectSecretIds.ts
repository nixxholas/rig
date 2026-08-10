import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import { readString } from "./impl/sqliteRow.js";

export async function queryProjectSecretIds(
    ctx: Context,
    projectId: string,
): Promise<readonly string[]> {
    return await inDatabase(ctx, "rig.sql.session.query_project_secret_ids", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT secret_id FROM project_secret_attachments
            WHERE project_id = ${projectId}
            ORDER BY secret_id
        `)
        ).map((row) => readString(row, "secret_id"));
    });
}
