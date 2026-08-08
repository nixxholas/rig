import { desc, eq, isNull } from "drizzle-orm";

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

/** Adds one folder, last among the siblings it is created in. */
export function folderCreate(tx: TX, input: FolderCreateInput): void {
    inTx(tx, (tx) => {
        const last = tx
            .select({ orderKey: folders.orderKey })
            .from(folders)
            .where(
                input.parentId === undefined
                    ? isNull(folders.parentId)
                    : eq(folders.parentId, input.parentId),
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
    });
}
