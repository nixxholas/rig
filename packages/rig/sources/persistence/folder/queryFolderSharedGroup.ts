import type { Context } from "@steve.kite/stdlib";

import { and, eq, isNull, sql } from "drizzle-orm";

import { folderItems, folders, sessions } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";

export async function queryFolderSharedGroup(
    ctx: Context,
    folderId: string,
): Promise<string | undefined> {
    return await inDatabase(ctx, "rig.sql.folder.queryFolderSharedGroup", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx.get<{ groupId: string }>(sql`
        WITH RECURSIVE ancestors(id, parent_id, shared_group_id) AS (
            SELECT id, parent_id, shared_group_id
            FROM folders
            WHERE id = ${folderId} AND archived_at_ms IS NULL
            UNION ALL
            SELECT parent.id, parent.parent_id, parent.shared_group_id
            FROM folders parent
            JOIN ancestors child ON child.parent_id = parent.id
            WHERE parent.archived_at_ms IS NULL
        )
        SELECT shared_group_id AS groupId
        FROM ancestors
        WHERE shared_group_id IS NOT NULL
        LIMIT 1
    `)
        )?.groupId;
    });
}

export async function querySharedFolderRoot(
    ctx: Context,
    groupId: string,
): Promise<string | undefined> {
    return await inDatabase(ctx, "rig.sql.folder.querySharedFolderRoot", async (ctx) => {
        const tx = ctx.tx;
        return (
            await tx
                .select({ id: folders.id })
                .from(folders)
                .where(eq(folders.sharedGroupId, groupId))
                .get()
        )?.id;
    });
}

export async function queryFolderShareRootProblem(
    ctx: Context,
    folderId: string,
): Promise<"contents" | "missing" | "not_root" | "shared" | undefined> {
    return await inDatabase(ctx, "rig.sql.folder.queryFolderShareRootProblem", async (ctx) => {
        const tx = ctx.tx;
        const folder = await tx
            .select({
                archivedAtMs: folders.archivedAtMs,
                parentId: folders.parentId,
                sharedGroupId: folders.sharedGroupId,
            })
            .from(folders)
            .where(eq(folders.id, folderId))
            .get();
        if (folder === undefined || folder.archivedAtMs !== null) return "missing";
        if (folder.sharedGroupId !== null) return "shared";
        if (
            (await tx
                .select({ id: folderItems.id })
                .from(folderItems)
                .where(and(eq(folderItems.folderId, folderId), isNull(folderItems.archivedAtMs)))
                .get()) !== undefined ||
            (await tx
                .select({ id: sessions.id })
                .from(sessions)
                .where(
                    and(
                        eq(sessions.folderId, folderId),
                        eq(sessions.scopeKind, "folder"),
                        eq(sessions.archived, false),
                    ),
                )
                .get()) !== undefined
        ) {
            return "contents";
        }
        return folder.parentId === null ? undefined : "not_root";
    });
}

export async function queryFolderSubtreeHasContents(
    ctx: Context,
    folderId: string,
): Promise<boolean> {
    return await inDatabase(ctx, "rig.sql.folder.queryFolderSubtreeHasContents", async (ctx) => {
        const tx = ctx.tx;
        return (
            (await tx.get<{ found: number }>(sql`
            WITH RECURSIVE subtree(id) AS (
                SELECT id
                FROM folders
                WHERE id = ${folderId} AND archived_at_ms IS NULL
                UNION ALL
                SELECT child.id
                FROM folders child
                JOIN subtree parent ON child.parent_id = parent.id
                WHERE child.archived_at_ms IS NULL
            )
            SELECT 1 AS found
            FROM subtree
            WHERE EXISTS (
                SELECT 1
                FROM folder_items
                WHERE folder_items.folder_id = subtree.id
                  AND folder_items.archived_at_ms IS NULL
            ) OR EXISTS (
                SELECT 1
                FROM sessions
                WHERE sessions.folder_id = subtree.id
                  AND sessions.scope_kind = 'folder'
                  AND sessions.archived = 0
            )
            LIMIT 1
        `)) !== undefined
        );
    });
}
