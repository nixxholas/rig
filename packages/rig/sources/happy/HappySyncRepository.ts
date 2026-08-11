import { happyOutboxAcknowledge } from "../persistence/happy/happyOutboxAcknowledge.js";
import {
    happyOutboxEnqueue,
    HappySyncOutboxFullError,
} from "../persistence/happy/happyOutboxEnqueue.js";
import { happyOutboxEnqueueInitialBackfill } from "../persistence/happy/happyOutboxEnqueueInitialBackfill.js";
import {
    happyProjectionEnqueue,
    type HappyProjectionEnqueueResult,
} from "../persistence/happy/happyProjectionEnqueue.js";
import { happyProjectionStallGap } from "../persistence/happy/happyProjectionStallGap.js";
import { happySessionAdvanceRemoteSequence } from "../persistence/happy/happySessionAdvanceRemoteSequence.js";
import {
    happySessionEnsure,
    type HappySessionState,
} from "../persistence/happy/happySessionEnsure.js";
import { happySessionSetRemote } from "../persistence/happy/happySessionSetRemote.js";
import { queryHappyOutbox } from "../persistence/happy/queryHappyOutbox.js";
import { queryHappySession } from "../persistence/happy/queryHappySession.js";
import { queryHappySessionIds } from "../persistence/happy/queryHappySessionIds.js";
import {
    openSessionDatabase,
    type SessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { withDatabase } from "../persistence/databaseContext.js";
import type { HappyEncryptionVariant, HappySessionProtocolMessage } from "./types.js";
import type { Context } from "@steve.kite/stdlib";

const MAX_PENDING_MESSAGES_PER_SESSION = 10_000;
const MAX_RESTORED_SESSIONS = 64;
const RESTORED_SESSION_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export { HappySyncOutboxFullError };
export type { HappySessionState };

export class HappySyncRepository {
    readonly #database: SessionDatabase;
    readonly #maxPendingMessagesPerSession: number;
    readonly #now: () => number;
    readonly #ownsDatabase: boolean;

    private constructor(
        database: SessionDatabase,
        now: () => number,
        maxPendingMessagesPerSession: number,
        ownsDatabase: boolean,
    ) {
        this.#database = database;
        this.#maxPendingMessagesPerSession = maxPendingMessagesPerSession;
        this.#now = now;
        this.#ownsDatabase = ownsDatabase;
    }

    static async open(
        ctx: Context,
        databasePath: string,
        now: () => number = Date.now,
        maxPendingMessagesPerSession = MAX_PENDING_MESSAGES_PER_SESSION,
    ): Promise<HappySyncRepository> {
        const opened = await openSessionDatabase(ctx, databasePath);
        return new HappySyncRepository(opened.database, now, maxPendingMessagesPerSession, true);
    }

    static using(
        database: SessionDatabase,
        now: () => number = Date.now,
        maxPendingMessagesPerSession = MAX_PENDING_MESSAGES_PER_SESSION,
    ): HappySyncRepository {
        return new HappySyncRepository(database, now, maxPendingMessagesPerSession, false);
    }

    async acknowledge(ctx: Context, sessionId: string, localIds: readonly string[]): Promise<void> {
        await happyOutboxAcknowledge(withDatabase(ctx, this.#database), sessionId, localIds);
    }

    async close(ctx: Context): Promise<void> {
        if (!this.#ownsDatabase) return;
        await this.#database.close(withDatabase(ctx, this.#database));
    }

    async enqueue(
        ctx: Context,
        sessionId: string,
        messages: readonly HappySessionProtocolMessage[],
    ): Promise<void> {
        await happyOutboxEnqueue(withDatabase(ctx, this.#database), {
            maxPendingMessages: this.#maxPendingMessagesPerSession,
            messages,
            now: this.#now,
            sessionId,
        });
    }

    async enqueueInitialBackfill(
        ctx: Context,
        sessionId: string,
        messages: readonly HappySessionProtocolMessage[],
        projectedEventId?: string,
    ): Promise<void> {
        await happyOutboxEnqueueInitialBackfill(withDatabase(ctx, this.#database), {
            maxPendingMessages: this.#maxPendingMessagesPerSession,
            messages,
            now: this.#now,
            ...(projectedEventId === undefined ? {} : { projectedEventId }),
            sessionId,
        });
    }

    async enqueueProjection(
        ctx: Context,
        sessionId: string,
        eventId: string,
        messages: readonly HappySessionProtocolMessage[],
    ): Promise<HappyProjectionEnqueueResult> {
        return await happyProjectionEnqueue(withDatabase(ctx, this.#database), {
            eventId,
            maxPendingMessages: this.#maxPendingMessagesPerSession,
            messages,
            now: this.#now,
            sessionId,
        });
    }

    async stallProjectionGap(ctx: Context, sessionId: string, reason: string): Promise<void> {
        await happyProjectionStallGap(withDatabase(ctx, this.#database), {
            now: this.#now(),
            reason,
            sessionId,
        });
    }

    ensureSession(
        ctx: Context,
        options: {
            credentialFingerprint: string;
            encryptionKey?: Uint8Array;
            encryptionVariant: HappyEncryptionVariant;
            sessionId: string;
        },
    ): Promise<HappySessionState> {
        return happySessionEnsure(withDatabase(ctx, this.#database), {
            ...options,
            now: this.#now(),
        });
    }

    async getSession(ctx: Context, sessionId: string): Promise<HappySessionState | undefined> {
        return queryHappySession(withDatabase(ctx, this.#database), sessionId);
    }

    /** Sessions worth reconnecting after a restart, most recently active first. */
    sessionIds(
        ctx: Context,
        credentialFingerprint: string,
        options: { activeSinceMs?: number; limit?: number } = {},
    ): Promise<readonly string[]> {
        return queryHappySessionIds(withDatabase(ctx, this.#database), {
            activeSinceMs:
                options.activeSinceMs ?? this.#now() - RESTORED_SESSION_ACTIVITY_WINDOW_MS,
            credentialFingerprint,
            limit: options.limit ?? MAX_RESTORED_SESSIONS,
        });
    }

    async pending(
        ctx: Context,
        sessionId: string,
        limit = 50,
    ): Promise<readonly HappySessionProtocolMessage[]> {
        return queryHappyOutbox(withDatabase(ctx, this.#database), sessionId, limit);
    }

    async setRemoteSession(
        ctx: Context,
        sessionId: string,
        remoteSessionId: string,
    ): Promise<void> {
        await happySessionSetRemote(withDatabase(ctx, this.#database), {
            now: this.#now(),
            remoteSessionId,
            sessionId,
        });
    }

    async updateLastRemoteSeq(ctx: Context, sessionId: string, sequence: number): Promise<void> {
        await happySessionAdvanceRemoteSequence(withDatabase(ctx, this.#database), {
            now: this.#now(),
            sequence,
            sessionId,
        });
    }
}
