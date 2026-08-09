import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { HappyEncryptionVariant } from "../../happy/types.js";
import { happySessions } from "../database/schema.js";
import type { HappySessionState } from "./happySessionEnsure.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryHappySession(
    tx: DatabaseScope,
    sessionId: string,
): Promise<HappySessionState | undefined> {
    return await inDatabase(tx, async (tx) => {
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
            lastRemoteSeq: row.lastRemoteSeq,
            ...(row.remoteSessionId === null ? {} : { remoteSessionId: row.remoteSessionId }),
            sessionId: row.sessionId,
            tag: row.tag,
        };
    });
}
