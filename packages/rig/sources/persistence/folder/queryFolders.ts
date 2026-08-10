import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { asc } from "drizzle-orm";

import type { Folder } from "../../protocol/index.js";
import { folders } from "../database/schema.js";
import { folderReadRow } from "./impl/folderReadRow.js";

/**
 * The whole tree, every parent ahead of the folders nested under it and siblings in order key.
 *
 * The rows come back in sibling order and are then arranged into tree order here. A folder whose
 * parent is missing is treated as a root, so nothing can disappear from the tree.
 */
export async function queryFolders(ctx: Context): Promise<readonly Folder[]> {
    return await inDatabase(ctx, "rig.sql.folder.queryFolders", async (ctx) => {
        const tx = ctx.tx;
        const ordered = (
            await tx.select().from(folders).orderBy(asc(folders.orderKey), asc(folders.id)).all()
        ).map((row) => folderReadRow(row));
        const known = new Set(ordered.map((folder) => folder.id));
        const children = new Map<string, Folder[]>();
        const roots: Folder[] = [];
        for (const folder of ordered) {
            const parentId = folder.parentId;
            if (parentId === undefined || !known.has(parentId)) {
                roots.push(folder);
                continue;
            }
            const siblings = children.get(parentId);
            if (siblings === undefined) children.set(parentId, [folder]);
            else siblings.push(folder);
        }
        roots.sort(
            (left, right) =>
                Number(right.shared) - Number(left.shared) || compareFolderOrder(left, right),
        );
        const arranged: Folder[] = [];
        const placed = new Set<string>();
        const visit = (folder: Folder): void => {
            if (placed.has(folder.id)) return;
            placed.add(folder.id);
            arranged.push(folder);
            for (const child of children.get(folder.id) ?? []) visit(child);
        };
        for (const root of roots) visit(root);
        return arranged;
    });
}

function compareFolderOrder(left: Folder, right: Folder): number {
    return (
        (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
}
