import { eq } from "drizzle-orm";

import type { HappyEncryptionVariant } from "../../happy/types.js";
import { happySessions } from "../database/schema.js";
import type { HappySessionState } from "./happySessionEnsure.js";
import type { TX } from "../Transaction.js";

export function queryHappySession(tx: TX, sessionId: string): HappySessionState | undefined {
    const row = tx.select().from(happySessions).where(eq(happySessions.sessionId, sessionId)).get();
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
}
