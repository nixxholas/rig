import type { Context } from "@steve.kite/stdlib";

import { eq, isNotNull, sql } from "drizzle-orm";

import { advanceFolderCatalogRevision } from "../folder/advanceFolderCatalogRevision.js";
import {
    folders,
    folderShareIntents,
    folderShares,
    sharingProfileBinding,
} from "../database/schema.js";
import { inTx } from "../inTx.js";

/**
 * Removes every application record whose meaning depends on Murmur's cryptographic store.
 *
 * The selected profile and enabled setting remain. Clearing the bound identity lets the freshly
 * opened Murmur client bind its new identity to that same profile.
 */
export async function sharingStateReset(ctx: Context, now: number): Promise<number | undefined> {
    return await inTx(ctx, "rig.sql.sharing.sharingStateReset", async (ctx) => {
        const tx = ctx.tx;
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
        return clearedRoots === 0 ? undefined : await advanceFolderCatalogRevision(ctx);
    });
}
