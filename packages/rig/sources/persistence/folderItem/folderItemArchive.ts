import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNull, sql } from "drizzle-orm";

import { folderItems } from "../database/schema.js";

export async function folderItemArchive(
    ctx: Context,
    id: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.folderItem.folderItemArchive", async (ctx) => {
        const tx = ctx.tx;
        return Number(
            (
                await tx
                    .update(folderItems)
                    .set({
                        archivedAtMs: now,
                        updatedAtMs: now,
                        version: sql`${folderItems.version} + 1`,
                    })
                    .where(
                        and(
                            eq(folderItems.id, id),
                            isNull(folderItems.archivedAtMs),
                            version === undefined ? sql`1` : eq(folderItems.version, version),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
