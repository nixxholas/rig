import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { HappyCloudProfileCiphertextResponse } from "../../protocol/HappyCloudProtocol.js";
import { happyCloudEnrollment } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappyCloudProfile(
    tx: DatabaseScope,
): Promise<HappyCloudProfileCiphertextResponse | undefined> {
    return await inDatabase(tx, async (tx) => {
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
