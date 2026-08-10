import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, inArray, isNull, sql } from "drizzle-orm";

import { folderItems, folders, sessions } from "../database/schema.js";

/**
 * Archives one folder together with everything nested under it.
 *
 * A folder that is already archived keeps the moment it was archived, so re-archiving a subtree
 * that was partly put away earlier only touches what is still visible.
 */
export async function folderArchive(
    ctx: Context,
    id: string,
    now: number,
): Promise<{ folders: number; sessionIds: readonly string[] }> {
    return await inDatabase(ctx, "rig.sql.folder.folderArchive", async (ctx) => {
        const tx = ctx.tx;
        const subtree = sql`
        WITH RECURSIVE subtree(id) AS (
            SELECT id FROM folders WHERE id = ${id}
            UNION ALL
            SELECT folders.id FROM folders JOIN subtree ON folders.parent_id = subtree.id
        )
        SELECT id FROM subtree
    `;
        const sessionIds = (
            await tx
                .select({ id: sessions.id })
                .from(sessions)
                .where(
                    and(
                        sql`${sessions.folderId} IN (${subtree})`,
                        sql`${sessions.scopeKind} = 'folder'`,
                        sql`${sessions.sessionKind} = 'primary'`,
                        isNull(sessions.parentSessionId),
                    ),
                )
                .all()
        ).map((row) => row.id);
        const archivedFolders = Number(
            (
                await tx
                    .update(folders)
                    .set({
                        archivedAtMs: now,
                        updatedAtMs: now,
                        version: sql`${folders.version} + 1`,
                    })
                    .where(and(sql`${folders.id} IN (${subtree})`, isNull(folders.archivedAtMs)))
                    .run()
            ).rowsAffected,
        );
        await tx
            .update(folderItems)
            .set({ archivedAtMs: now, updatedAtMs: now, version: sql`${folderItems.version} + 1` })
            .where(
                and(sql`${folderItems.folderId} IN (${subtree})`, isNull(folderItems.archivedAtMs)),
            )
            .run();
        if (sessionIds.length > 0) {
            await tx
                .update(sessions)
                .set({ archived: true, updatedAtMs: now })
                .where(inArray(sessions.id, sessionIds))
                .run();
        }
        return { folders: archivedFolders, sessionIds };
    });
}
