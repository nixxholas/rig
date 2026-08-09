import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";

import type { FolderItem } from "../../protocol/index.js";
import { folderItems } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryFolderItems(
    tx: DatabaseScope,
    folderId?: string,
): Promise<readonly FolderItem[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx
                .select()
                .from(folderItems)
                .where(folderId === undefined ? undefined : eq(folderItems.folderId, folderId))
                .orderBy(asc(folderItems.folderId), asc(folderItems.orderKey), asc(folderItems.id))
                .all()
        ).map(read);
    });
}

export async function queryFolderItem(
    tx: DatabaseScope,
    itemId: string,
): Promise<FolderItem | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.select().from(folderItems).where(eq(folderItems.id, itemId)).get();
        return row === undefined ? undefined : read(row);
    });
}

function read(row: typeof folderItems.$inferSelect): FolderItem {
    const target =
        row.projectId !== null
            ? ({ kind: "project", projectId: row.projectId } as const)
            : row.workspaceId !== null
              ? ({ kind: "workspace", workspaceId: row.workspaceId } as const)
              : ({ documentId: row.documentId!, kind: "document" } as const);
    return {
        ...(row.archivedAtMs === null ? {} : { archivedAt: row.archivedAtMs }),
        createdAt: row.createdAtMs,
        folderId: row.folderId,
        id: row.id,
        orderKey: row.orderKey,
        target,
        updatedAt: row.updatedAtMs,
        version: row.version,
    };
}
