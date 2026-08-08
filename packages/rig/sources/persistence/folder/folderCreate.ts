import { and, desc, eq, isNull } from "drizzle-orm";

import { folders } from "../database/schema.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

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
        const last = tx
            .select({ orderKey: folders.orderKey })
            .from(folders)
            .where(
                and(
                    input.parentId === undefined
                        ? isNull(folders.parentId)
                        : eq(folders.parentId, input.parentId),
                    isNull(folders.archivedAtMs),
                ),
            )
            .orderBy(desc(folders.orderKey))
            .limit(1)
            .get();
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
