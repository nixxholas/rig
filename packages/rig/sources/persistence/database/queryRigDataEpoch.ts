import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigDataEpochSchema } from "../../protocol/InstallationProtocol.js";
import type { DatabaseScope } from "../Transaction.js";
import { inDatabase } from "./inDatabase.js";
import { rigDataIdentityTable } from "./schema.js";
import type { DrizzleSessionTx } from "./SessionDatabase.js";

export async function queryRigDataEpoch(tx: DatabaseScope): Promise<string> {
    const epoch = await queryRigDataEpochIfPresent(tx);
    if (epoch === undefined) {
        throw new Error("The initialized Rig database has no data identity.");
    }
    return epoch;
}

export async function queryRigDataEpochIfPresent(tx: DatabaseScope): Promise<string | undefined> {
    return await inDatabase(tx, queryRigDataEpochIfPresentInTx);
}

export async function queryRigDataEpochIfPresentInTx(
    tx: DrizzleSessionTx,
): Promise<string | undefined> {
    const rows = await tx
        .select({ epoch: rigDataIdentityTable.epoch })
        .from(rigDataIdentityTable)
        .where(eq(rigDataIdentityTable.singleton, 1))
        .all();
    const row = rows[0];
    return row === undefined ? undefined : Value.Decode(rigDataEpochSchema, row.epoch);
}
