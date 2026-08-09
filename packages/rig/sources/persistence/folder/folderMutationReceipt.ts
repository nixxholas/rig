import { eq, sql } from "drizzle-orm";

import { folderMutations } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { inDatabase } from "../database/inDatabase.js";
import { inTx } from "../inTx.js";

const MAX_FOLDER_MUTATION_RECEIPTS = 10_000;

export interface FolderMutationReceipt {
    readonly action: string;
    readonly folderId: string;
}

export async function queryFolderMutationReceipt(
    tx: DatabaseScope,
    mutationId: string,
): Promise<FolderMutationReceipt | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select({
                action: folderMutations.action,
                folderId: folderMutations.folderId,
            })
            .from(folderMutations)
            .where(eq(folderMutations.mutationId, mutationId))
            .get();
        return row;
    });
}

export async function recordFolderMutationReceipt(
    tx: DatabaseScope,
    input: {
        action: string;
        folderId: string;
        mutationId: string;
        now: number;
    },
): Promise<void> {
    await inTx(tx, async (tx) => {
        await tx
            .insert(folderMutations)
            .values({
                action: input.action,
                createdAtMs: input.now,
                folderId: input.folderId,
                mutationId: input.mutationId,
            })
            .run();
        await tx.run(sql`
            DELETE FROM folder_mutations
            WHERE mutation_id IN (
                SELECT mutation_id
                FROM folder_mutations
                ORDER BY created_at_ms DESC, mutation_id DESC
                LIMIT -1 OFFSET ${MAX_FOLDER_MUTATION_RECEIPTS}
            )
        `);
    });
}
