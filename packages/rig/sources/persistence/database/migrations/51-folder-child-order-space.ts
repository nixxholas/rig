import { sql } from "drizzle-orm";

import { generateKeyBetween } from "../../../utils/fractionalIndexing.js";
import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

const ROOT_GROUP = "\u0000root";

interface ChildRow {
    readonly id: string;
    readonly kind: "folder" | "item";
    readonly orderKey: string;
    readonly parentId: string | null;
}

/**
 * Gives folders and folder items one order-key space in every folder.
 *
 * Before this migration the two tables generated keys independently, so a folder and an item in
 * the same parent could both have `a0`. Existing relative order is preserved as far as the old
 * independent lists allow it: folders retain their old order first, then items retain their old
 * order. Stable ids break ties within either old list.
 */
export async function folderChildOrderSpace(database: SessionDatabase): Promise<void> {
    const collision = (
        await database.all<{ id: string }>(
            sql.raw(`
            SELECT folders.id AS id
            FROM folders
            INNER JOIN folder_items ON folder_items.id = folders.id
            ORDER BY folders.id
            LIMIT 1
        `),
        )
    )[0];
    if (collision !== undefined) {
        throw new Error(
            "Cannot enable shared folder ordering because a folder and folder item have the same ID.",
        );
    }

    const children = new Map<string, ChildRow[]>();
    const add = (row: ChildRow): void => {
        const group = children.get(row.parentId ?? ROOT_GROUP);
        if (group === undefined) children.set(row.parentId ?? ROOT_GROUP, [row]);
        else group.push(row);
    };

    for (const row of await database.all<{
        id: string;
        orderKey: string;
        parentId: string | null;
    }>(sql.raw("SELECT id, order_key AS orderKey, parent_id AS parentId FROM folders"))) {
        add({ ...row, kind: "folder" });
    }
    for (const row of await database.all<{
        id: string;
        orderKey: string;
        parentId: string;
    }>(sql.raw("SELECT id, order_key AS orderKey, folder_id AS parentId FROM folder_items"))) {
        add({ ...row, kind: "item" });
    }

    for (const group of children.values()) {
        group.sort(
            (left, right) =>
                (left.kind === right.kind ? 0 : left.kind === "folder" ? -1 : 1) ||
                compareText(left.orderKey, right.orderKey) ||
                compareText(left.id, right.id),
        );
        let previous: string | null = null;
        for (const child of group) {
            const orderKey = generateKeyBetween(previous, null);
            if (child.kind === "folder") {
                await database.run(
                    sql`UPDATE folders SET order_key = ${orderKey} WHERE id = ${child.id}`,
                );
            } else {
                await database.run(
                    sql`UPDATE folder_items SET order_key = ${orderKey} WHERE id = ${child.id}`,
                );
            }
            previous = orderKey;
        }
    }
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
