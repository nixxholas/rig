import { asc, eq } from "drizzle-orm";

import type { FolderItem } from "../../protocol/index.js";
import { folderItems } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryFolderItems(tx: TX, folderId?: string): readonly FolderItem[] {
    return tx
        .select()
        .from(folderItems)
        .where(folderId === undefined ? undefined : eq(folderItems.folderId, folderId))
        .orderBy(asc(folderItems.folderId), asc(folderItems.orderKey), asc(folderItems.id))
        .all()
        .map(read);
}

export function queryFolderItem(tx: TX, itemId: string): FolderItem | undefined {
    const row = tx.select().from(folderItems).where(eq(folderItems.id, itemId)).get();
    return row === undefined ? undefined : read(row);
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
