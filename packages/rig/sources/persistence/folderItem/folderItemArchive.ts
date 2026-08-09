import { and, eq, isNull, sql } from "drizzle-orm";

import { folderItems } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function folderItemArchive(tx: TX, id: string, now: number, version?: number): number {
    return Number(
        tx
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
            .run().changes,
    );
}
