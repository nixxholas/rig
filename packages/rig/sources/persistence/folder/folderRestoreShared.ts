import { and, eq, isNotNull, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";
import type { DatabaseScope } from "../Transaction.js";

/** Restores one previously archived folder while applying a newer shared-folder operation. */
export async function folderRestoreShared(
    tx: DatabaseScope,
    folderId: string,
    parentId: string,
    orderKey: string,
    now: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) =>
        Number(
            (
                await tx
                    .update(folders)
                    .set({
                        archivedAtMs: null,
                        orderKey,
                        parentId,
                        updatedAtMs: now,
                        version: sql`${folders.version} + 1`,
                    })
                    .where(and(eq(folders.id, folderId), isNotNull(folders.archivedAtMs)))
                    .run()
            ).rowsAffected,
        ),
    );
}
