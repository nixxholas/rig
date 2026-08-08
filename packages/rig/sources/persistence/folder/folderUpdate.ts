import { and, eq, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/** An absent field is left as it is; an explicit `null` clears it. */
export interface FolderUpdateInput {
    description?: string | null;
    icon?: string | null;
    name?: string;
    rules?: string | null;
}

export function folderUpdate(
    tx: TX,
    id: string,
    input: FolderUpdateInput,
    now: number,
    version?: number,
): number {
    return Number(
        tx
            .update(folders)
            .set({
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.icon === undefined ? {} : { icon: input.icon }),
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.rules === undefined ? {} : { rules: input.rules }),
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
