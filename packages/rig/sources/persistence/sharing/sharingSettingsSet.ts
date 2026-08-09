import { inDatabase } from "../database/inDatabase.js";
import type { DatabaseScope } from "../Transaction.js";
import { sharingSettings } from "../database/schema.js";

export async function sharingSettingsSet(
    tx: DatabaseScope,
    enabled: boolean,
    updatedAt: number,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .insert(sharingSettings)
            .values({ enabled, singletonId: 1, updatedAtMs: updatedAt })
            .onConflictDoUpdate({
                set: { enabled, updatedAtMs: updatedAt },
                target: sharingSettings.singletonId,
            })
            .run();
    });
}
