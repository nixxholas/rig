import { eq, sql } from "drizzle-orm";

import { folderItemMutations } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryFolderItemMutationReceipt(
    tx: TX,
    mutationId: string,
): { action: string; fingerprint: string; itemId: string } | undefined {
    const row = tx
        .select()
        .from(folderItemMutations)
        .where(eq(folderItemMutations.mutationId, mutationId))
        .get();
    return row === undefined
        ? undefined
        : { action: row.action, fingerprint: row.requestFingerprint, itemId: row.itemId };
}

export function recordFolderItemMutationReceipt(
    tx: TX,
    input: {
        action: string;
        fingerprint: string;
        itemId: string;
        mutationId: string;
        now: number;
    },
): void {
    tx.insert(folderItemMutations)
        .values({
            action: input.action,
            createdAtMs: input.now,
            itemId: input.itemId,
            mutationId: input.mutationId,
            requestFingerprint: input.fingerprint,
        })
        .run();
    tx.run(
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
}
