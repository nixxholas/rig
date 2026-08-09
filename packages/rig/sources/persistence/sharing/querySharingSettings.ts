import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { sharingSettings } from "../database/schema.js";

export interface SharingSettings {
    enabled: boolean;
    updatedAt: number;
}

export async function querySharingSettings(
    tx: DatabaseScope,
): Promise<SharingSettings | undefined> {
    return await inDatabase(tx, async (tx) => {
        const stored = await tx
            .select({
                enabled: sharingSettings.enabled,
                updatedAt: sharingSettings.updatedAtMs,
            })
            .from(sharingSettings)
            .where(eq(sharingSettings.singletonId, 1))
            .get();
        return stored === undefined ? undefined : stored;
    });
}
