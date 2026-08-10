import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { HappyCloudProfileCiphertextResponse } from "../../protocol/HappyCloudProtocol.js";
import { happyCloudEnrollment } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappyCloudProfile(
    ctx: Context,
): Promise<HappyCloudProfileCiphertextResponse | undefined> {
    return await inDatabase(ctx, "rig.sql.happy_cloud.query_profile", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx
            .select({
                ciphertext: happyCloudEnrollment.profileCiphertext,
                version: happyCloudEnrollment.profileVersion,
            })
            .from(happyCloudEnrollment)
            .where(eq(happyCloudEnrollment.singletonId, 1))
            .get();
        return row?.ciphertext === null ||
            row?.ciphertext === undefined ||
            row.version === null ||
            row.version === undefined
            ? undefined
            : { ciphertext: row.ciphertext, version: row.version };
    });
}
