import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { readWorkletRow, readWorkletVersionRow, type StoredWorklet } from "./queryWorklets.js";

export async function queryWorklet(ctx: Context, name: string): Promise<StoredWorklet | undefined> {
    return await inDatabase(ctx, "rig.sql.worklets.query_one", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.get<Record<string, unknown>>(
            sql`SELECT * FROM worklets WHERE name = ${name}`,
        );
        if (row === undefined) return undefined;
        const versions = (
            await tx.all<Record<string, unknown>>(
                sql`SELECT * FROM worklet_versions WHERE worklet_name = ${name} ORDER BY version ASC`,
            )
        ).map(readWorkletVersionRow);
        return readWorkletRow(row, versions);
    });
}
