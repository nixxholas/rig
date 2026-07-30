import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { happyOutbox, happySessions } from "../database/schema.js";
import type { HappyEncryptionVariant } from "../../happy/types.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export interface HappySessionState {
    credentialFingerprint: string;
    encryptionKey: Uint8Array;
    encryptionVariant: HappyEncryptionVariant;
    lastRemoteSeq: number;
    remoteSessionId?: string;
    sessionId: string;
    tag: string;
}

export function happySessionEnsure(
    tx: TX,
    input: {
        credentialFingerprint: string;
        encryptionKey?: Uint8Array;
        encryptionVariant: HappyEncryptionVariant;
        now: number;
        sessionId: string;
    },
): HappySessionState {
    return inTx(tx, (tx) => {
        const current = tx
            .select()
            .from(happySessions)
            .where(eq(happySessions.sessionId, input.sessionId))
            .get();
        if (
            current?.credentialFingerprint === input.credentialFingerprint &&
            current.encryptionVariant === input.encryptionVariant
        ) {
            return toSessionState(current);
        }

        const encryptionKey =
            input.encryptionKey === undefined
                ? new Uint8Array(randomBytes(32))
                : new Uint8Array(input.encryptionKey);
        if (encryptionKey.length !== 32) {
            throw new Error("Happy session encryption keys must contain 32 bytes.");
        }
        const tag = `rig:${input.sessionId}`;
        tx.insert(happySessions)
            .values({
                createdAtMs: input.now,
                credentialFingerprint: input.credentialFingerprint,
                encryptionKeyBase64: Buffer.from(encryptionKey).toString("base64"),
                encryptionVariant: input.encryptionVariant,
                lastRemoteSeq: 0,
                remoteSessionId: null,
                sessionId: input.sessionId,
                tag,
                updatedAtMs: input.now,
            })
            .onConflictDoUpdate({
                target: happySessions.sessionId,
                set: {
                    credentialFingerprint: input.credentialFingerprint,
                    encryptionKeyBase64: Buffer.from(encryptionKey).toString("base64"),
                    encryptionVariant: input.encryptionVariant,
                    lastRemoteSeq: 0,
                    remoteSessionId: null,
                    tag,
                    updatedAtMs: input.now,
                },
            })
            .run();
        if (current !== undefined) {
            tx.delete(happyOutbox).where(eq(happyOutbox.sessionId, input.sessionId)).run();
        }
        return {
            credentialFingerprint: input.credentialFingerprint,
            encryptionKey,
            encryptionVariant: input.encryptionVariant,
            lastRemoteSeq: 0,
            sessionId: input.sessionId,
            tag,
        };
    });
}

function toSessionState(row: typeof happySessions.$inferSelect): HappySessionState {
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
