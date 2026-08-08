import { and, eq, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export type FolderMoveResult =
    | { outcome: "cycle" }
    | { outcome: "folder_not_found" }
    | { outcome: "moved" }
    | { outcome: "parent_archived" }
    | { outcome: "parent_not_found" }
    | { outcome: "version_conflict" };

/** Puts one folder under a new active parent at a new order key. */
export function folderMove(
    tx: TX,
    id: string,
    parentId: string | null,
    orderKey: string,
    now: number,
    version?: number,
): FolderMoveResult {
    return inTx(tx, (tx) => {
        const folder = tx
            .select({ version: folders.version })
            .from(folders)
            .where(eq(folders.id, id))
            .get();
        if (folder === undefined) return { outcome: "folder_not_found" };
        if (version !== undefined && folder.version !== version) {
            return { outcome: "version_conflict" };
        }
        if (parentId !== null) {
            const parent = tx
                .select({ archivedAtMs: folders.archivedAtMs })
                .from(folders)
                .where(eq(folders.id, parentId))
                .get();
            if (parent === undefined) return { outcome: "parent_not_found" };
            if (parent.archivedAtMs !== null) return { outcome: "parent_archived" };
            const cycle = tx.get<Record<string, unknown>>(sql`
                WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM folders WHERE id = ${id}
                    UNION
                    SELECT folders.id
                    FROM folders JOIN subtree ON folders.parent_id = subtree.id
                )
                SELECT id FROM subtree WHERE id = ${parentId} LIMIT 1
            `);
            if (cycle !== undefined) return { outcome: "cycle" };
        }
        const changed = Number(
            tx
                .update(folders)
                .set({
                    orderKey,
                    parentId,
                    updatedAtMs: now,
                    version: sql`${folders.version} + 1`,
                })
                .where(
                    and(
                        eq(folders.id, id),
                        version === undefined ? sql`1` : eq(folders.version, version),
                    ),
                )
                .run().changes,
        );
        return changed === 1 ? { outcome: "moved" } : { outcome: "version_conflict" };
    });
}
