import { and, eq, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Puts one folder under a new parent at a new order key.
 *
 * Nesting is virtual, so a move only rewrites these two columns; the folder's storage directory
 * never moves. The caller has already refused a parent inside the folder's own subtree.
 */
export function folderMove(
    tx: TX,
    id: string,
    parentId: string | null,
    orderKey: string,
    now: number,
    version?: number,
): number {
    return Number(
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
}
