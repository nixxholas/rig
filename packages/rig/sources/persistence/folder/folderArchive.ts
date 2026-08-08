import { and, isNull, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Archives one folder together with everything nested under it.
 *
 * A folder that is already archived keeps the moment it was archived, so re-archiving a subtree
 * that was partly put away earlier only touches what is still visible.
 */
export function folderArchive(tx: TX, id: string, now: number): number {
    return Number(
        tx
            .update(folders)
            .set({ archivedAtMs: now, updatedAtMs: now, version: sql`${folders.version} + 1` })
            .where(
                and(
                    sql`${folders.id} IN (
                        WITH RECURSIVE subtree(id) AS (
                            SELECT id FROM folders WHERE id = ${id}
                            UNION ALL
                            SELECT folders.id FROM folders JOIN subtree ON folders.parent_id = subtree.id
                        )
                        SELECT id FROM subtree
                    )`,
                    isNull(folders.archivedAtMs),
                ),
            )
            .run().changes,
    );
}
