import type { TX } from "../Transaction.js";
import { sharingSettings } from "../database/schema.js";

export function sharingSettingsSet(tx: TX, enabled: boolean, updatedAt: number): void {
    tx.insert(sharingSettings)
        .values({ enabled, singletonId: 1, updatedAtMs: updatedAt })
        .onConflictDoUpdate({
            set: { enabled, updatedAtMs: updatedAt },
            target: sharingSettings.singletonId,
        })
        .run();
}
