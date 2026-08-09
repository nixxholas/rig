import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

/** An absent field is left as it is; an explicit `null` clears it. */
export interface FolderUpdateInput {
    description?: string | null;
    icon?: string | null;
    name?: string;
    rules?: string | null;
}

export async function folderUpdate(
    tx: DatabaseScope,
    id: string,
    input: FolderUpdateInput,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(folders)
                    .set({
                        ...(input.description === undefined
                            ? {}
                            : { description: input.description }),
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
                    .run()
            ).rowsAffected,
        );
    });
}
