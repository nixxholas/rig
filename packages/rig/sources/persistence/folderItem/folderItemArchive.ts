import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNull, sql } from "drizzle-orm";

import { folderItems } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function folderItemArchive(
    tx: DatabaseScope,
    id: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
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
