import { eq } from "drizzle-orm";

import { folderItems, folders } from "../database/schema.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { queryFolderChildren } from "./queryFolderChildren.js";

export interface FolderCreateInput {
    description?: string;
    icon?: string;
    id: string;
    name: string;
    now: number;
    /** Absent places the folder at the root of the tree. */
    parentId?: string;
    /** Flat storage directory the caller has already created. */
    path: string;
    rules?: string;
}

export type FolderCreateResult =
    | { outcome: "created" }
    | { outcome: "id_conflict" }
    | { outcome: "parent_archived" }
    | { outcome: "parent_not_found" };

/** Adds one folder, last among the siblings it is created in. */
export function folderCreate(tx: TX, input: FolderCreateInput): FolderCreateResult {
    return inTx(tx, (tx) => {
        if (input.parentId !== undefined) {
            const parent = tx
                .select({ archivedAtMs: folders.archivedAtMs })
                .from(folders)
                .where(eq(folders.id, input.parentId))
                .get();
            if (parent === undefined) return { outcome: "parent_not_found" };
            if (parent.archivedAtMs !== null) return { outcome: "parent_archived" };
        }
        if (
            tx
                .select({ id: folderItems.id })
                .from(folderItems)
                .where(eq(folderItems.id, input.id))
                .get() !== undefined
        ) {
            return { outcome: "id_conflict" };
        }
        const last = queryFolderChildren(tx, input.parentId ?? null).at(-1);
        tx.insert(folders)
            .values({
                createdAtMs: input.now,
                description: input.description ?? null,
                icon: input.icon ?? null,
                id: input.id,
                name: input.name,
                orderKey: generateKeyBetween(last?.orderKey ?? null, null),
                parentId: input.parentId ?? null,
                path: input.path,
                rules: input.rules ?? null,
                updatedAtMs: input.now,
                version: 1,
            })
            .run();
        return { outcome: "created" };
    });
}
