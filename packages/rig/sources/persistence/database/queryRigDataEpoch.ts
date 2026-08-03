import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigDataEpochSchema } from "../../protocol/InstallationProtocol.js";
import type { TX } from "../Transaction.js";
import { rigDataIdentityTable } from "./schema.js";

export function queryRigDataEpoch(tx: TX): string {
    const epoch = queryRigDataEpochIfPresent(tx);
    if (epoch === undefined) {
        throw new Error("The initialized Rig database has no data identity.");
    }
    return epoch;
}

export function queryRigDataEpochIfPresent(tx: TX): string | undefined {
    const row = tx
        .select({ epoch: rigDataIdentityTable.epoch })
        .from(rigDataIdentityTable)
        .where(eq(rigDataIdentityTable.singleton, 1))
        .get();
    return row === undefined ? undefined : Value.Decode(rigDataEpochSchema, row.epoch);
}
