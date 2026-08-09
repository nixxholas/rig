import { eq } from "drizzle-orm";

import type { WorkletPermissions } from "../../protocol/WorkletProtocol.js";
import { worklets, workletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export interface WorkletVersionRecord {
    changeDescription: string;
    createdAt: number;
    description: string;
    permissions: WorkletPermissions;
    version: number;
}

/** Records a newly imported version with its manifest and makes it current in one step. */
export async function workletAddVersion(
    tx: DatabaseScope,
    name: string,
    record: WorkletVersionRecord,
): Promise<void> {
    await inTx(tx, async (transaction) => {
        await transaction
            .insert(workletVersions)
            .values({
                changeDescription: record.changeDescription,
                createdAtMs: record.createdAt,
                description: record.description,
                permissionsJson: JSON.stringify(record.permissions),
                version: record.version,
                workletName: name,
            })
            .run();
        await transaction
            .update(worklets)
            .set({ currentVersion: record.version, updatedAtMs: record.createdAt })
            .where(eq(worklets.name, name))
            .run();
    });
}
