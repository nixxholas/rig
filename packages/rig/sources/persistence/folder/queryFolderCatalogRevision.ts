import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

/** The durable revision represented by a folder catalog snapshot. */
export async function queryFolderCatalogRevision(ctx: Context): Promise<number> {
    return await inDatabase(ctx, "rig.sql.folder.queryFolderCatalogRevision", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.get<{ revision: number }>(
            sql.raw("SELECT revision FROM folder_catalog WHERE id = 1"),
        );
        if (row === undefined || !Number.isSafeInteger(row.revision) || row.revision < 0) {
            throw new Error("The folder catalog revision is unavailable.");
        }
        return row.revision;
    });
}
