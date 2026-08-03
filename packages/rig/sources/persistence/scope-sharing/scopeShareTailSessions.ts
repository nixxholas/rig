import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { createEventIdFactory } from "../../protocol/createEventIdFactory.js";
import { projectSessionShareProjection } from "../../session-sharing/projectSessionShareEntry.js";
import { scopeShareSessionCursors, scopeShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import {
    queryScopeShareScopeFacts,
    queryScopeShareSessionIds,
    queryScopeShareSessionIndex,
    type ScopeShareLabelResolver,
} from "./queryScopeShareSubjects.js";
import {
    scopeShareOutboxEnqueue,
    type ScopeShareEnqueueLimits,
} from "./scopeShareOutboxEnqueue.js";
import type { ScopeShareScopeKind } from "./types.js";

export interface ScopeShareTailLimits extends ScopeShareEnqueueLimits {
    /** Entries one session may contribute before its turn ends. */
    readonly sessionPageSize: number;
    /** Entries the whole pass may contribute, across every session. */
    readonly passEntryLimit: number;
    /** Bytes the whole pass may contribute, across every session. */
    readonly passByteLimit: number;
}

export interface ScopeShareTailResult {
    readonly appended: number;
    readonly degraded: boolean;
    /** Whether more work was waiting when the pass ran out of budget. */
    readonly pending: boolean;
}

/**
 * Move one shared scope's log forward by a bounded pass.
 *
 * A session share tails one session, so it can simply read until the page is full.
 * A scope share tails every session at once, and reading them in a fixed order
 * would let a single busy session consume every pass forever while the rest of the
 * workspace never appeared to a member at all. So each session holds a place in a
 * queue, takes at most `sessionPageSize` entries when its turn comes, and goes to
 * the back whether or not it had anything to say. The pass itself is bounded by the
 * same page limits the transport publishes under, which is what makes the tail
 * safe to call in a loop until it reports nothing pending.
 */
export function scopeShareTailSessions(
    tx: TX,
    input: {
        /** Whether transcript entries travel yet. Scope and session facts always do. */
        includeTranscript: boolean;
        limits: ScopeShareTailLimits;
        now: number;
        resolveLabels?: ScopeShareLabelResolver;
        shareId: string;
    },
): ScopeShareTailResult {
    return inTx(tx, (tx) => {
        const share = tx
            .select()
            .from(scopeShares)
            .where(eq(scopeShares.shareId, input.shareId))
            .get();
        if (share === undefined) throw new Error("The scope share does not exist.");
        if (share.state === "stopped") return { appended: 0, degraded: false, pending: false };
        const scope = {
            scopeId: share.scopeId,
            scopeKind: share.scopeKind as ScopeShareScopeKind,
        };
        const createShareEventId = createEventIdFactory({ now: () => input.now });
        const budget = new PassBudget(input.limits);
        let degraded = false;

        const enqueue = (
            projection: Parameters<typeof scopeShareOutboxEnqueue>[1]["projection"],
            sourceEventSeq?: number,
        ): "appended" | "degraded" | "full" => {
            if (budget.exhausted) return "full";
            const record = scopeShareOutboxEnqueue(tx, {
                createdAt: input.now,
                limits: input.limits,
                projection,
                shareEventId: createShareEventId(),
                shareId: input.shareId,
                ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }),
            });
            if (record === undefined) {
                degraded = true;
                return "degraded";
            }
            budget.spend(record.byteLength);
            return "appended";
        };

        const facts = queryScopeShareScopeFacts(tx, scope);
        if (facts !== undefined && facts.version > share.publishedScopeVersion) {
            const outcome = enqueue({ payload: facts.facts, subject: "scope", version: 1 });
            if (outcome === "appended") {
                tx.update(scopeShares)
                    .set({ publishedScopeVersion: facts.version, updatedAtMs: input.now })
                    .where(eq(scopeShares.shareId, input.shareId))
                    .run();
            }
        }

        if (!degraded) syncCursors(tx, { now: input.now, scope, shareId: input.shareId });

        let pending = false;
        if (!degraded) {
            const cursors = tx
                .select()
                .from(scopeShareSessionCursors)
                .where(eq(scopeShareSessionCursors.shareId, input.shareId))
                .orderBy(
                    asc(scopeShareSessionCursors.rotationSeq),
                    asc(scopeShareSessionCursors.sessionId),
                )
                .all();
            let rotation = nextRotation(tx, input.shareId);
            for (const cursor of cursors) {
                if (budget.exhausted) {
                    pending = pending || cursors.length > 0;
                    break;
                }
                let publishedEventSeq = cursor.publishedEventSeq;
                let indexVersion = cursor.indexVersion;
                let served = 0;

                const session = queryScopeShareSessionIndex(tx, {
                    ...(input.resolveLabels === undefined
                        ? {}
                        : { resolveLabels: input.resolveLabels }),
                    scope,
                    sessionId: cursor.sessionId,
                });
                // A session index entry is written only once the session row has moved,
                // so identical facts are never published twice and the log never has to
                // supersede anything it has already handed out.
                if (session !== undefined && session.version > indexVersion) {
                    const outcome = enqueue({
                        payload: session.index,
                        sessionId: cursor.sessionId,
                        subject: "session_index",
                        version: 1,
                    });
                    if (outcome === "degraded") break;
                    if (outcome === "full") {
                        pending = true;
                        break;
                    }
                    indexVersion = session.version;
                    served += 1;
                }

                if (
                    input.includeTranscript &&
                    !budget.exhausted &&
                    served < input.limits.sessionPageSize
                ) {
                    const transcript = tailTranscript(tx, {
                        budget,
                        enqueue,
                        limit: input.limits.sessionPageSize - served,
                        publishedEventSeq,
                        sessionId: cursor.sessionId,
                    });
                    publishedEventSeq = transcript.publishedEventSeq;
                    served += transcript.served;
                    pending = pending || transcript.pending;
                    if (transcript.degraded) degraded = true;
                }

                tx.update(scopeShareSessionCursors)
                    .set({
                        indexVersion,
                        publishedEventSeq,
                        rotationSeq: rotation,
                        updatedAtMs: input.now,
                    })
                    .where(
                        and(
                            eq(scopeShareSessionCursors.shareId, input.shareId),
                            eq(scopeShareSessionCursors.sessionId, cursor.sessionId),
                        ),
                    )
                    .run();
                rotation += 1;
                if (degraded) break;
            }
        }

        if (degraded) {
            tx.update(scopeShares)
                .set({ state: "degraded", updatedAtMs: input.now })
                .where(eq(scopeShares.shareId, input.shareId))
                .run();
        }
        return { appended: budget.entries, degraded, pending: pending && !degraded };
    });
}

class PassBudget {
    #bytes = 0;
    #entries = 0;
    readonly #limits: ScopeShareTailLimits;

    constructor(limits: ScopeShareTailLimits) {
        this.#limits = limits;
    }

    get entries(): number {
        return this.#entries;
    }

    get exhausted(): boolean {
        return (
            this.#entries >= this.#limits.passEntryLimit ||
            this.#bytes >= this.#limits.passByteLimit
        );
    }

    spend(byteLength: number): void {
        this.#bytes += byteLength;
        this.#entries += 1;
    }
}

/**
 * Give every session in the scope a place in the queue, and take away the place of
 * any that has left it.
 *
 * A new cursor starts at rotation 0 so a session that has just appeared is served
 * before the ones that have already had their turn.
 */
function syncCursors(
    tx: TX,
    input: {
        now: number;
        scope: { scopeId: string; scopeKind: ScopeShareScopeKind };
        shareId: string;
    },
): void {
    const sessionIds = queryScopeShareSessionIds(tx, input.scope);
    tx.delete(scopeShareSessionCursors)
        .where(
            sessionIds.length === 0
                ? eq(scopeShareSessionCursors.shareId, input.shareId)
                : and(
                      eq(scopeShareSessionCursors.shareId, input.shareId),
                      notInArray(scopeShareSessionCursors.sessionId, [...sessionIds]),
                  ),
        )
        .run();
    if (sessionIds.length === 0) return;
    const known = new Set(
        tx
            .select({ sessionId: scopeShareSessionCursors.sessionId })
            .from(scopeShareSessionCursors)
            .where(
                and(
                    eq(scopeShareSessionCursors.shareId, input.shareId),
                    inArray(scopeShareSessionCursors.sessionId, [...sessionIds]),
                ),
            )
            .all()
            .map((row) => row.sessionId),
    );
    for (const sessionId of sessionIds) {
        if (known.has(sessionId)) continue;
        tx.insert(scopeShareSessionCursors)
            .values({
                createdAtMs: input.now,
                indexVersion: -1,
                publishedEventSeq: 0,
                rotationSeq: 0,
                sessionId,
                shareId: input.shareId,
                updatedAtMs: input.now,
            })
            .run();
    }
}

/** The place at the back of the queue the next served cursor takes. */
function nextRotation(tx: TX, shareId: string): number {
    const row = tx.get<{ rotation: number | null }>(sql`
        SELECT MAX(rotation_seq) AS rotation
        FROM scope_share_session_cursors
        WHERE share_id = ${shareId}
    `);
    return (row?.rotation ?? 0) + 1;
}

function tailTranscript(
    tx: TX,
    input: {
        budget: PassBudget;
        enqueue: (
            projection: Parameters<typeof scopeShareOutboxEnqueue>[1]["projection"],
            sourceEventSeq?: number,
        ) => "appended" | "degraded" | "full";
        limit: number;
        publishedEventSeq: number;
        sessionId: string;
    },
): { degraded: boolean; pending: boolean; publishedEventSeq: number; served: number } {
    const rows = tx.all<{
        created_at_ms: number;
        data_json: string;
        event_id: string;
        seq: number;
        type: SessionEvent["type"];
    }>(sql`
        SELECT seq, event_id, type, created_at_ms, data_json
        FROM session_events
        WHERE session_id = ${input.sessionId}
            AND seq > ${input.publishedEventSeq}
        ORDER BY seq ASC
        LIMIT ${input.limit}
    `);
    let publishedEventSeq = input.publishedEventSeq;
    let served = 0;
    for (const row of rows) {
        const projection = projectSessionShareProjection({
            event: {
                createdAt: row.created_at_ms,
                data: JSON.parse(row.data_json) as Record<string, unknown>,
                id: row.event_id,
                sessionId: input.sessionId,
                type: row.type,
            } as SessionEvent,
            kind: "event",
        });
        // An event with no place in a transcript still moves the cursor: skipping it
        // silently is what keeps a session full of internal traffic from stalling.
        if (projection === undefined) {
            publishedEventSeq = row.seq;
            continue;
        }
        const outcome = input.enqueue(
            {
                payload: projection,
                sessionId: input.sessionId,
                subject: "session_event",
                version: 1,
            },
            row.seq,
        );
        if (outcome === "degraded")
            return { degraded: true, pending: false, publishedEventSeq, served };
        if (outcome === "full")
            return { degraded: false, pending: true, publishedEventSeq, served };
        publishedEventSeq = row.seq;
        served += 1;
    }
    return {
        degraded: false,
        pending: rows.length === input.limit,
        publishedEventSeq,
        served,
    };
}
