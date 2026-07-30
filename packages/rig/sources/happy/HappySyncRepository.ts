import { asc, eq } from "drizzle-orm";

import { happyOutboxAcknowledge } from "../persistence/happy/happyOutboxAcknowledge.js";
import {
    happyOutboxEnqueue,
    HappySyncOutboxFullError,
} from "../persistence/happy/happyOutboxEnqueue.js";
import { happySessionAdvanceRemoteSequence } from "../persistence/happy/happySessionAdvanceRemoteSequence.js";
import {
    happySessionEnsure,
    type HappySessionState,
} from "../persistence/happy/happySessionEnsure.js";
import { happySessionSetRemote } from "../persistence/happy/happySessionSetRemote.js";
import {
    openSessionDatabase,
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { happyOutbox, happySessions } from "../persistence/database/schema.js";
import type { HappyEncryptionVariant, HappySessionProtocolMessage } from "./types.js";

const MAX_PENDING_MESSAGES_PER_SESSION = 10_000;

export { HappySyncOutboxFullError };
export type { HappySessionState };

export class HappySyncRepository {
    readonly #client: ReturnType<typeof openSessionDatabase>["client"];
    readonly #database: SessionDatabase;
    readonly #maxPendingMessagesPerSession: number;
    readonly #now: () => number;

    constructor(
        databasePath: string,
        now: () => number = Date.now,
        maxPendingMessagesPerSession = MAX_PENDING_MESSAGES_PER_SESSION,
    ) {
        const opened = openSessionDatabase(databasePath);
        this.#client = opened.client;
        this.#database = opened.database;
        this.#client.pragma("journal_mode = WAL");
        this.#client.pragma("synchronous = FULL");
        this.#client.pragma("foreign_keys = ON");
        this.#maxPendingMessagesPerSession = maxPendingMessagesPerSession;
        this.#now = now;
    }

    acknowledge(sessionId: string, localIds: readonly string[]): void {
        happyOutboxAcknowledge(this.#database, sessionId, localIds);
    }

    close(): void {
        this.#client.close();
    }

    enqueue(sessionId: string, messages: readonly HappySessionProtocolMessage[]): void {
        happyOutboxEnqueue(this.#database, {
            maxPendingMessages: this.#maxPendingMessagesPerSession,
            messages,
            now: this.#now,
            sessionId,
        });
    }

    ensureSession(options: {
        credentialFingerprint: string;
        encryptionKey?: Uint8Array;
        encryptionVariant: HappyEncryptionVariant;
        sessionId: string;
    }): HappySessionState {
        return happySessionEnsure(this.#database, {
            ...options,
            now: this.#now(),
        });
    }

    getSession(sessionId: string): HappySessionState | undefined {
        const row = this.#database
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
            sessionId,
            tag: row.tag,
        };
    }

    pending(sessionId: string, limit = 50): readonly HappySessionProtocolMessage[] {
        return this.#database
            .select({ payloadJson: happyOutbox.payloadJson })
            .from(happyOutbox)
            .where(eq(happyOutbox.sessionId, sessionId))
            .orderBy(asc(happyOutbox.seq))
            .limit(limit)
            .all()
            .map((row) => JSON.parse(row.payloadJson) as HappySessionProtocolMessage);
    }

    setRemoteSession(sessionId: string, remoteSessionId: string): void {
        happySessionSetRemote(this.#database, {
            now: this.#now(),
            remoteSessionId,
            sessionId,
        });
    }

    updateLastRemoteSeq(sessionId: string, sequence: number): void {
        happySessionAdvanceRemoteSequence(this.#database, {
            now: this.#now(),
            sequence,
            sessionId,
        });
    }
}
