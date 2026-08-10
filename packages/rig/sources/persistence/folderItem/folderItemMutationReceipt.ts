import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq, sql } from "drizzle-orm";

import { folderItemMutations } from "../database/schema.js";

export async function queryFolderItemMutationReceipt(
    ctx: Context,
    mutationId: string,
): Promise<{ action: string; fingerprint: string; itemId: string } | undefined> {
    return await inDatabase(
        ctx,
        "rig.sql.folderItem.queryFolderItemMutationReceipt",
        async (ctx) => {
            const tx = ctx.tx;
            const row = await tx
                .select()
                .from(folderItemMutations)
                .where(eq(folderItemMutations.mutationId, mutationId))
                .get();
            return row === undefined
                ? undefined
                : { action: row.action, fingerprint: row.requestFingerprint, itemId: row.itemId };
        },
    );
}

export async function recordFolderItemMutationReceipt(
    ctx: Context,
    input: {
        action: string;
        fingerprint: string;
        itemId: string;
        mutationId: string;
        now: number;
    },
): Promise<void> {
    return await inDatabase(
        ctx,
        "rig.sql.folderItem.recordFolderItemMutationReceipt",
        async (ctx) => {
            const tx = ctx.tx;
            await tx
                .insert(folderItemMutations)
                .values({
                    action: input.action,
                    createdAtMs: input.now,
                    itemId: input.itemId,
                    mutationId: input.mutationId,
                    requestFingerprint: input.fingerprint,
                })
                .run();
            await tx.run(
                sql`
        DELETE FROM folder_item_mutations
        WHERE item_id = ${input.itemId}
          AND action != 'create'
          AND mutation_id IN (
            SELECT mutation_id FROM folder_item_mutations
            WHERE item_id = ${input.itemId}
              AND action != 'create'
            ORDER BY created_at_ms DESC, mutation_id DESC
            LIMIT -1 OFFSET 10000
        )
        `,
            );
        },
    );
}
