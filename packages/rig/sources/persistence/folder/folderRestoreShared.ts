import { and, eq, isNotNull, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** Restores one previously archived folder while applying a newer shared-folder operation. */
export function folderRestoreShared(
    tx: TX,
    folderId: string,
    parentId: string,
    orderKey: string,
    now: number,
): number {
    return tx
        .update(folders)
        .set({
            archivedAtMs: null,
            orderKey,
            parentId,
            updatedAtMs: now,
            version: sql`${folders.version} + 1`,
        })
        .where(and(eq(folders.id, folderId), isNotNull(folders.archivedAtMs)))
        .run().changes;
}
