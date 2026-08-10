import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { HappyCloudSessionBlobResponse } from "../../protocol/HappyCloudProtocol.js";
import { happyCloudSessionBlobs } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappyCloudSessionBlob(
    ctx: Context,
    sessionId: string,
): Promise<HappyCloudSessionBlobResponse | undefined> {
    return await inDatabase(ctx, "rig.sql.happy_cloud.query_session_blob", async (ctx) => {
        const tx = ctx.tx;
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
