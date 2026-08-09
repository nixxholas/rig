import { and, desc, eq, isNull } from "drizzle-orm";

import type { FolderItemTarget } from "../../protocol/index.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { folderItems, folders } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export type FolderItemCreateResult = { outcome: "created" } | { outcome: "folder_not_found" };

export function folderItemCreate(
    tx: TX,
    input: {
        folderId: string;
        id: string;
        now: number;
        orderKey?: string;
        target: FolderItemTarget;
    },
): FolderItemCreateResult {
    return inTx(tx, (tx) => {
        const folder = tx
            .select({ archivedAtMs: folders.archivedAtMs })
            .from(folders)
            .where(eq(folders.id, input.folderId))
            .get();
        if (folder === undefined || folder.archivedAtMs !== null) {
            return { outcome: "folder_not_found" };
        }
        const last = tx
            .select({ orderKey: folderItems.orderKey })
            .from(folderItems)
            .where(and(eq(folderItems.folderId, input.folderId), isNull(folderItems.archivedAtMs)))
            .orderBy(desc(folderItems.orderKey))
            .limit(1)
            .get();
        tx.insert(folderItems)
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
