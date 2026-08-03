import { eq } from "drizzle-orm";

import type { HappyCloudSessionBlobResponse } from "../../protocol/HappyCloudProtocol.js";
import { happyCloudSessionBlobs } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryHappyCloudSessionBlob(
    tx: TX,
    sessionId: string,
): HappyCloudSessionBlobResponse | undefined {
    return tx
        .select({
            ciphertext: happyCloudSessionBlobs.ciphertext,
            sessionId: happyCloudSessionBlobs.sessionId,
            version: happyCloudSessionBlobs.version,
        })
        .from(happyCloudSessionBlobs)
        .where(eq(happyCloudSessionBlobs.sessionId, sessionId))
        .get();
}
