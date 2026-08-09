import type { WorkletPermissions } from "../../protocol/WorkletProtocol.js";
import { worklets, workletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export interface WorkletCreateRecord {
    authorSessionId: string;
    changeDescription: string;
    createdAt: number;
    description: string;
    iconThumbhash: string;
    name: string;
    permissions: WorkletPermissions;
    sourceDescription?: string;
}

/** Writes the worklet identity together with its first version so neither exists alone. */
export async function workletCreate(tx: DatabaseScope, record: WorkletCreateRecord): Promise<void> {
    await inTx(tx, async (transaction) => {
        await transaction
            .insert(worklets)
            .values({
                authorSessionId: record.authorSessionId,
                createdAtMs: record.createdAt,
                currentVersion: 1,
                iconThumbhash: record.iconThumbhash,
                name: record.name,
                sourceDescription: record.sourceDescription ?? null,
                updatedAtMs: record.createdAt,
            })
            .run();
        await transaction
            .insert(workletVersions)
            .values({
                changeDescription: record.changeDescription,
                createdAtMs: record.createdAt,
                description: record.description,
                permissionsJson: JSON.stringify(record.permissions),
                version: 1,
                workletName: record.name,
            })
            .run();
    });
}
