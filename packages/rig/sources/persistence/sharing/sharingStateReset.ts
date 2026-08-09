import { eq, isNotNull, sql } from "drizzle-orm";

import { advanceFolderCatalogRevision } from "../folder/advanceFolderCatalogRevision.js";
import {
    folders,
    folderShareIntents,
    folderShares,
    sharingProfileBinding,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

/**
 * Removes every application record whose meaning depends on Murmur's cryptographic store.
 *
 * The selected profile and enabled setting remain. Clearing the bound identity lets the freshly
 * opened Murmur client bind its new identity to that same profile.
 */
export function sharingStateReset(tx: TX, now: number): number | undefined {
    return inTx(tx, (tx) => {
        const clearedRoots = tx
            .update(folders)
            .set({
                sharedGroupId: null,
                updatedAtMs: now,
                version: sql`${folders.version} + 1`,
            })
            .where(isNotNull(folders.sharedGroupId))
            .run().changes;
        tx.delete(folderShareIntents).run();
        tx.delete(folderShares).run();
        tx.update(sharingProfileBinding)
            .set({ murmurIdentity: null })
            .where(eq(sharingProfileBinding.singletonId, 1))
            .run();
        return clearedRoots === 0 ? undefined : advanceFolderCatalogRevision(tx);
    });
}
