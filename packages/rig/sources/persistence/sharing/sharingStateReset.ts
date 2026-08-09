import { eq, isNotNull, sql } from "drizzle-orm";

import { advanceFolderCatalogRevision } from "../folder/advanceFolderCatalogRevision.js";
import {
    folders,
    folderShareIntents,
    folderShares,
    sharingProfileBinding,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

/**
 * Removes every application record whose meaning depends on Murmur's cryptographic store.
 *
 * The selected profile and enabled setting remain. Clearing the bound identity lets the freshly
 * opened Murmur client bind its new identity to that same profile.
 */
export async function sharingStateReset(
    tx: DatabaseScope,
    now: number,
): Promise<number | undefined> {
    return await inTx(tx, async (tx) => {
        const clearedRoots = (
            await tx
                .update(folders)
                .set({
                    sharedGroupId: null,
                    updatedAtMs: now,
                    version: sql`${folders.version} + 1`,
                })
                .where(isNotNull(folders.sharedGroupId))
                .run()
        ).rowsAffected;
        await tx.delete(folderShareIntents).run();
        await tx.delete(folderShares).run();
        await tx
            .update(sharingProfileBinding)
            .set({ murmurIdentity: null })
            .where(eq(sharingProfileBinding.singletonId, 1))
            .run();
        return clearedRoots === 0 ? undefined : await advanceFolderCatalogRevision(tx);
    });
}
