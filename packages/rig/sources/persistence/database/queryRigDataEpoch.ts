import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { rigDataEpochSchema } from "../../protocol/InstallationProtocol.js";
import { inDatabase } from "./inDatabase.js";
import { rigDataIdentityTable } from "./schema.js";

export async function queryRigDataEpoch(ctx: Context): Promise<string> {
    const epoch = await queryRigDataEpochIfPresent(ctx);
    if (epoch === undefined) {
        throw new Error("The initialized Rig database has no data identity.");
    }
    return epoch;
}

export async function queryRigDataEpochIfPresent(ctx: Context): Promise<string | undefined> {
    return await inDatabase(
        ctx,
        "rig.sql.database.query_data_epoch",
        queryRigDataEpochIfPresentInTx,
    );
}

export async function queryRigDataEpochIfPresentInTx(ctx: Context): Promise<string | undefined> {
    const tx = ctx.tx;
    const rows = await tx
        .select({ epoch: rigDataIdentityTable.epoch })
        .from(rigDataIdentityTable)
        .where(eq(rigDataIdentityTable.singleton, 1))
        .all();
    const row = rows[0];
    return row === undefined ? undefined : Value.Decode(rigDataEpochSchema, row.epoch);
}
