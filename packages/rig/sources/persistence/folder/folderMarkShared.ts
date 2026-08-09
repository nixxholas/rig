import { and, eq, isNull, sql } from "drizzle-orm";

import { folderItems, folders, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { queryFolderChildren } from "./queryFolderChildren.js";

export type FolderMarkSharedResult =
    | { outcome: "contents_forbidden" }
    | { outcome: "folder_not_found" }
    | { outcome: "group_conflict" }
    | { outcome: "marked" }
    | { outcome: "not_root" };

/** Marks an empty root as one Murmur group and moves it before every other root. */
export async function folderMarkShared(
    tx: DatabaseScope,
    folderId: string,
    groupId: string,
    now: number,
): Promise<FolderMarkSharedResult> {
    return await inTx(tx, async (tx) => {
        const folder = await tx
            .select({
                archivedAtMs: folders.archivedAtMs,
                parentId: folders.parentId,
                sharedGroupId: folders.sharedGroupId,
            })
            .from(folders)
            .where(eq(folders.id, folderId))
            .get();
        if (folder === undefined || folder.archivedAtMs !== null) {
            return { outcome: "folder_not_found" };
        }
        if (folder.sharedGroupId === groupId) return { outcome: "marked" };
        if (folder.sharedGroupId !== null) return { outcome: "group_conflict" };
        if (folder.parentId !== null) return { outcome: "not_root" };
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
            return { outcome: "contents_forbidden" };
        }
        const first = (await queryFolderChildren(tx, null)).find(
            (candidate) => candidate.id !== folderId,
        );
        const orderKey = generateKeyBetween(null, first?.orderKey ?? null);
        await tx
            .update(folders)
            .set({
                orderKey,
                sharedGroupId: groupId,
                updatedAtMs: now,
                version: sql`${folders.version} + 1`,
            })
            .where(eq(folders.id, folderId))
            .run();
        return { outcome: "marked" };
    });
}
