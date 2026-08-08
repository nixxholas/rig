import { asc, eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import type { TX } from "../Transaction.js";
import { p2pProvisionedProviders } from "../database/schema.js";
import {
    p2pProvisionedProviderRecordSchema,
    type P2pProvisionedProviderRecord,
} from "./P2pProvisionedProviderRecord.js";

export function queryP2pProvisionedProviders(
    tx: TX,
    ownerInstanceId?: string,
): readonly P2pProvisionedProviderRecord[] {
    const query =
        ownerInstanceId === undefined
            ? tx.select().from(p2pProvisionedProviders)
            : tx
                  .select()
                  .from(p2pProvisionedProviders)
                  .where(eq(p2pProvisionedProviders.ownerInstanceId, ownerInstanceId));
    return query
        .orderBy(
            asc(p2pProvisionedProviders.ownerInstanceId),
            asc(p2pProvisionedProviders.position),
            asc(p2pProvisionedProviders.providerId),
        )
        .all()
        .map((row) => {
            const record: unknown = {
                createdAt: row.createdAtMs,
                encryptedMaterialJson: row.encryptedMaterialJson,
                ownerInstanceId: row.ownerInstanceId,
                position: row.position,
                providerId: row.providerId,
                publicConfigJson: row.publicConfigJson,
                sourceDigest: row.sourceDigest,
                updatedAt: row.updatedAtMs,
                visibility: row.visibility,
            };
            if (!Value.Check(p2pProvisionedProviderRecordSchema, record)) {
                throw new Error("The saved P2P provisioned provider is invalid.");
            }
            return record;
        });
}
