import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { HappyEncryptionVariant } from "../../happy/types.js";
import { happySessions } from "../database/schema.js";
import type { HappySessionState } from "./happySessionEnsure.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappySession(
    ctx: Context,
    sessionId: string,
): Promise<HappySessionState | undefined> {
    return await inDatabase(ctx, "rig.sql.happy.query_session", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx
            .select()
            .from(happySessions)
            .where(eq(happySessions.sessionId, sessionId))
            .get();
        if (row === undefined) return undefined;
        return {
            credentialFingerprint: row.credentialFingerprint,
            encryptionKey: new Uint8Array(Buffer.from(row.encryptionKeyBase64, "base64")),
            encryptionVariant: row.encryptionVariant as HappyEncryptionVariant,
            historyBackfilled: row.historyBackfilled,
            lastRemoteSeq: row.lastRemoteSeq,
            ...(row.remoteSessionId === null ? {} : { remoteSessionId: row.remoteSessionId }),
            ...(row.projectedEventId === null ? {} : { projectedEventId: row.projectedEventId }),
            ...(row.projectedEventSeq === null ? {} : { projectedEventSeq: row.projectedEventSeq }),
            ...(row.projectionError === null ? {} : { projectionError: row.projectionError }),
            ...(row.projectionStallCause === null
                ? {}
                : { projectionStallCause: row.projectionStallCause }),
            projectionStatus: row.projectionStatus,
            sessionId: row.sessionId,
            tag: row.tag,
        };
    });
}
