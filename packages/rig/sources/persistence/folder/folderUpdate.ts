import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";

import { folders } from "../database/schema.js";

/** An absent field is left as it is; an explicit `null` clears it. */
export interface FolderUpdateInput {
    description?: string | null;
    icon?: string | null;
    name?: string;
    rules?: string | null;
}

export async function folderUpdate(
    ctx: Context,
    id: string,
    input: FolderUpdateInput,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(ctx, "rig.sql.folder.folderUpdate", async (ctx) => {
        const tx = ctx.tx;
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
