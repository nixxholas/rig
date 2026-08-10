import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, asc, eq, isNull } from "drizzle-orm";

import { folderItems, folders } from "../database/schema.js";

/** One active folder or folder item in the same direct-child ordering space. */
export interface FolderChildOrder {
    readonly id: string;
    readonly orderKey: string;
}

/**
 * Reads the active direct children of one folder, or the active root folders when `parentId` is
 * null. Folder items cannot be placed at the root, so the root query only returns folders.
 */
export async function queryFolderChildren(
    ctx: Context,
    parentId: string | null,
): Promise<readonly FolderChildOrder[]> {
    return await inDatabase(ctx, "rig.sql.folder.queryFolderChildren", async (ctx) => {
        const tx = ctx.tx;
        const childFolders = await tx
            .select({
                id: folders.id,
                orderKey: folders.orderKey,
                sharedGroupId: folders.sharedGroupId,
            })
            .from(folders)
            .where(
                and(
                    parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
                    isNull(folders.archivedAtMs),
                ),
            )
            .orderBy(asc(folders.orderKey), asc(folders.id))
            .all();
        if (parentId === null) {
            return childFolders.sort(
                (left, right) =>
                    Number(right.sharedGroupId !== null) - Number(left.sharedGroupId !== null) ||
                    compareChildren(left, right),
            );
        }

        const childItems = await tx
            .select({ id: folderItems.id, orderKey: folderItems.orderKey })
            .from(folderItems)
            .where(and(eq(folderItems.folderId, parentId), isNull(folderItems.archivedAtMs)))
            .orderBy(asc(folderItems.orderKey), asc(folderItems.id))
            .all();
        return [...childFolders, ...childItems].sort(compareChildren);
    });
}

function compareChildren(left: FolderChildOrder, right: FolderChildOrder): number {
    if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
