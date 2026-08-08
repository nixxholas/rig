import { eq } from "drizzle-orm";

import type { WorkletPermissions } from "../../protocol/WorkletProtocol.js";
import { worklets, workletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export interface WorkletVersionRecord {
    changeDescription: string;
    createdAt: number;
    description: string;
    permissions: WorkletPermissions;
    version: number;
}

/** Records a newly imported version with its manifest and makes it current in one step. */
export function workletAddVersion(tx: TX, name: string, record: WorkletVersionRecord): void {
    inTx(tx, (transaction) => {
        transaction
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
        transaction
            .update(worklets)
            .set({ currentVersion: record.version, updatedAtMs: record.createdAt })
            .where(eq(worklets.name, name))
            .run();
    });
}
