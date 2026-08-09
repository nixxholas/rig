import { eq } from "drizzle-orm";

import type { FolderItemTarget } from "../../protocol/index.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { folderItems, folders } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import { queryFolderChildren } from "../folder/queryFolderChildren.js";

export type FolderItemCreateResult =
    | { outcome: "created" }
    | { outcome: "folder_not_found" }
    | { outcome: "id_conflict" };

export async function folderItemCreate(
    tx: DatabaseScope,
    input: {
        folderId: string;
        id: string;
        now: number;
        orderKey?: string;
        target: FolderItemTarget;
    },
): Promise<FolderItemCreateResult> {
    return await inTx(tx, async (tx) => {
        const folder = await tx
            .select({ archivedAtMs: folders.archivedAtMs })
            .from(folders)
            .where(eq(folders.id, input.folderId))
            .get();
        if (folder === undefined || folder.archivedAtMs !== null) {
            return { outcome: "folder_not_found" };
        }
        if (
            (await tx
                .select({ id: folders.id })
                .from(folders)
                .where(eq(folders.id, input.id))
                .get()) !== undefined
        ) {
            return { outcome: "id_conflict" };
        }
        const last = (await queryFolderChildren(tx, input.folderId)).at(-1);
        await tx
            .insert(folderItems)
            .values({
                createdAtMs: input.now,
                folderId: input.folderId,
                id: input.id,
                orderKey: input.orderKey ?? generateKeyBetween(last?.orderKey ?? null, null),
                updatedAtMs: input.now,
                version: 1,
                ...(input.target.kind === "project"
                    ? { projectId: input.target.projectId }
                    : input.target.kind === "workspace"
                      ? { workspaceId: input.target.workspaceId }
                      : { documentId: input.target.documentId }),
            })
            .run();
        return { outcome: "created" };
    });
}
