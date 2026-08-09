import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { HappyCloudSessionBlobResponse } from "../../protocol/HappyCloudProtocol.js";
import { happyCloudSessionBlobs } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappyCloudSessionBlob(
    tx: DatabaseScope,
    sessionId: string,
): Promise<HappyCloudSessionBlobResponse | undefined> {
    return await inDatabase(tx, async (tx) => {
        return await tx
            .select({
                ciphertext: happyCloudSessionBlobs.ciphertext,
                sessionId: happyCloudSessionBlobs.sessionId,
                version: happyCloudSessionBlobs.version,
            })
            .from(happyCloudSessionBlobs)
            .where(eq(happyCloudSessionBlobs.sessionId, sessionId))
            .get();
    });
}
