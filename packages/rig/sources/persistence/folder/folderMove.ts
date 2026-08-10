import type { Context } from "@steve.kite/stdlib";

import { and, eq, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import { inTx } from "../inTx.js";

export type FolderMoveResult =
    | { outcome: "cycle" }
    | { outcome: "folder_not_found" }
    | { outcome: "moved" }
    | { outcome: "parent_archived" }
    | { outcome: "parent_not_found" }
    | { outcome: "version_conflict" };

/** Puts one folder under a new active parent at a new order key. */
export async function folderMove(
    ctx: Context,
    id: string,
    parentId: string | null,
    orderKey: string,
    now: number,
    version?: number,
): Promise<FolderMoveResult> {
    return await inTx(ctx, "rig.sql.folder.folderMove", async (ctx) => {
        const tx = ctx.tx;
        const folder = await tx
            .select({ version: folders.version })
            .from(folders)
            .where(eq(folders.id, id))
            .get();
        if (folder === undefined) return { outcome: "folder_not_found" };
        if (version !== undefined && folder.version !== version) {
            return { outcome: "version_conflict" };
        }
        if (parentId !== null) {
            const parent = await tx
                .select({ archivedAtMs: folders.archivedAtMs })
                .from(folders)
                .where(eq(folders.id, parentId))
                .get();
            if (parent === undefined) return { outcome: "parent_not_found" };
            if (parent.archivedAtMs !== null) return { outcome: "parent_archived" };
            const cycle = await tx.get<Record<string, unknown>>(sql`
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
            (
                await tx
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
                    .run()
            ).rowsAffected,
        );
        return changed === 1 ? { outcome: "moved" } : { outcome: "version_conflict" };
    });
}
