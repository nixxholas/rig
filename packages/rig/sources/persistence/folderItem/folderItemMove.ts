import { and, eq, sql } from "drizzle-orm";

import { folderItems, folders } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export type FolderItemMoveResult =
    | { outcome: "folder_not_found" }
    | { outcome: "item_not_found" }
    | { outcome: "moved" }
    | { outcome: "version_conflict" };

export async function folderItemMove(
    tx: DatabaseScope,
    id: string,
    folderId: string,
    orderKey: string,
    now: number,
    version?: number,
): Promise<FolderItemMoveResult> {
    return await inTx(tx, async (tx) => {
        const item = await tx
            .select({ version: folderItems.version })
            .from(folderItems)
            .where(eq(folderItems.id, id))
            .get();
        if (item === undefined) return { outcome: "item_not_found" };
        if (version !== undefined && item.version !== version) {
            return { outcome: "version_conflict" };
        }
        const folder = await tx
            .select({ archivedAtMs: folders.archivedAtMs })
            .from(folders)
            .where(eq(folders.id, folderId))
            .get();
        if (folder === undefined || folder.archivedAtMs !== null) {
            return { outcome: "folder_not_found" };
        }
        const changed = (
            await tx
                .update(folderItems)
                .set({
                    folderId,
                    orderKey,
                    updatedAtMs: now,
                    version: sql`${folderItems.version} + 1`,
                })
                .where(
                    and(
                        eq(folderItems.id, id),
                        version === undefined ? sql`1` : eq(folderItems.version, version),
                    ),
                )
                .run()
        ).rowsAffected;
        return changed === 1 ? { outcome: "moved" } : { outcome: "version_conflict" };
    });
}
