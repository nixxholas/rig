import { eq } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { sharingSettings } from "../database/schema.js";

export interface SharingSettings {
    enabled: boolean;
    updatedAt: number;
}

export function querySharingSettings(tx: TX): SharingSettings | undefined {
    const stored = tx
        .select({
            enabled: sharingSettings.enabled,
            updatedAt: sharingSettings.updatedAtMs,
        })
        .from(sharingSettings)
        .where(eq(sharingSettings.singletonId, 1))
        .get();
    return stored === undefined ? undefined : stored;
}
