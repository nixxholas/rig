import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";

import type { FolderItem } from "../../protocol/index.js";
import { folderItems } from "../database/schema.js";

export async function queryFolderItems(
    ctx: Context,
    folderId?: string,
): Promise<readonly FolderItem[]> {
    return await inDatabase(ctx, "rig.sql.folderItem.queryFolderItems", async (ctx) => {
        const tx = ctx.tx;
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
    ctx: Context,
    itemId: string,
): Promise<FolderItem | undefined> {
    return await inDatabase(ctx, "rig.sql.folderItem.queryFolderItem", async (ctx) => {
        const tx = ctx.tx;
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
