import type { Folder } from "../../../protocol/index.js";
import type { folders } from "../../database/schema.js";

type FolderRow = typeof folders.$inferSelect;

export function folderReadRow(row: FolderRow): Folder {
    return {
        ...(row.archivedAtMs === null ? {} : { archivedAt: row.archivedAtMs }),
        createdAt: row.createdAtMs,
        ...(row.description === null ? {} : { description: row.description }),
        ...(row.icon === null ? {} : { icon: row.icon }),
        id: row.id,
        name: row.name,
        orderKey: row.orderKey,
        ...(row.parentId === null ? {} : { parentId: row.parentId }),
        path: row.path,
        ...(row.rules === null ? {} : { rules: row.rules }),
        shared: row.sharedGroupId !== null,
        updatedAt: row.updatedAtMs,
        version: row.version,
    };
}
