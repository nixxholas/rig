import { eq, sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { SessionEvent } from "../../protocol/index.js";
import { createEventIdFactory } from "../../protocol/createEventIdFactory.js";
import { projectSessionShareEntry } from "../../session-sharing/projectSessionShareEntry.js";
import { toSharedToolOutput } from "../../session-sharing/SharedToolOutput.js";
import { sessionShareOutbox, sessionShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionShareTailEvents(
    tx: TX,
    input: {
        maxOutboxBytes: number;
        maxOutboxCount: number;
        now: number;
        pageSize: number;
        shareId: string;
    },
): { appended: number; degraded: boolean; progressed: number; publishedEventSeq: number } {
    return inTx(tx, (tx) => {
        const share = tx
            .select()
            .from(sessionShares)
            .where(eq(sessionShares.shareId, input.shareId))
            .get();
        if (share === undefined) throw new Error("The session share does not exist.");
        if (share.state === "stopped") {
            return {
                appended: 0,
                degraded: false,
                progressed: 0,
                publishedEventSeq: share.publishedEventSeq,
            };
        }
        const createShareEventId = createEventIdFactory({ now: () => input.now });
        const toolOutput = toSharedToolOutput(share.toolOutput);
        let nextSequence = share.nextShareSequence;
        let outboxBytes = share.outboxBytes;
        let outboxCount = share.outboxCount;
        let publishedMessagePosition = share.publishedMessagePosition;
        let publishedEventSeq = share.publishedEventSeq;
        let appended = 0;
        let progressed = 0;
        let degraded = false;
        const snapshotBoundary = share.snapshotThroughPosition ?? -1;
        if (publishedMessagePosition < snapshotBoundary) {
            const messages = tx.all<{
                message_json: string;
                position: number;
                run_id: string | null;
                updated_at_ms: number;
            }>(sql`
                SELECT message_json, position, run_id, updated_at_ms
                FROM session_share_snapshot_messages
                WHERE share_id = ${input.shareId}
                    AND position > ${publishedMessagePosition}
                    AND position <= ${snapshotBoundary}
                ORDER BY position ASC
                LIMIT ${input.pageSize}
            `);
            for (const row of messages) {
                const projected = projectSessionShareEntry({
                    createdAt: row.updated_at_ms,
                    shareEventId: createShareEventId(),
                    shareId: input.shareId,
                    shareSequence: nextSequence,
                    source: {
                        kind: "message",
                        message: JSON.parse(row.message_json) as Message,
                        position: row.position,
                        ...(row.run_id === null ? {} : { runId: row.run_id }),
                    },
                    toolOutput,
                });
                if (projected === undefined) {
                    publishedMessagePosition = row.position;
                    progressed += 1;
                    continue;
                }
                const byteLength = Buffer.byteLength(projected.canonicalJson, "utf8");
                if (
                    outboxCount + 1 > input.maxOutboxCount ||
                    outboxBytes + byteLength > input.maxOutboxBytes
                ) {
                    degraded = true;
                    break;
                }
                tx.insert(sessionShareOutbox)
                    .values({
                        byteLength,
                        canonicalJson: projected.canonicalJson,
                        contentHash: projected.contentHash,
                        createdAtMs: projected.createdAt,
                        sequence: nextSequence,
                        shareEventId: projected.shareEventId,
                        shareId: input.shareId,
                    })
                    .run();
                appended += 1;
                progressed += 1;
                nextSequence += 1;
                outboxBytes += byteLength;
                outboxCount += 1;
                publishedMessagePosition = row.position;
            }
            if (!degraded && messages.length < input.pageSize) {
                if (publishedMessagePosition < snapshotBoundary) progressed += 1;
                publishedMessagePosition = snapshotBoundary;
            }
        }
        if (!degraded && publishedMessagePosition >= snapshotBoundary) {
            const events = tx.all<{
                created_at_ms: number;
                data_json: string;
                event_id: string;
                seq: number;
                type: SessionEvent["type"];
            }>(sql`
                SELECT seq, event_id, type, created_at_ms, data_json
                FROM session_events
                WHERE session_id = ${share.ownerSessionId}
                    AND seq > ${publishedEventSeq}
                ORDER BY seq ASC
                LIMIT ${input.pageSize}
            `);
            for (const row of events) {
                const eventData = JSON.parse(row.data_json) as Record<string, unknown>;
                if (
                    (row.type === "message_submitted" ||
                        row.type === "agent_message" ||
                        row.type === "system_notice") &&
                    messageWasIncludedInSnapshot(
                        tx,
                        share.ownerSessionId,
                        eventData,
                        snapshotBoundary,
                    )
                ) {
                    publishedEventSeq = row.seq;
                    progressed += 1;
                    continue;
                }
                const projected = projectSessionShareEntry({
                    createdAt: row.created_at_ms,
                    shareEventId: createShareEventId(),
                    shareId: input.shareId,
                    shareSequence: nextSequence,
                    source: {
                        event: {
                            createdAt: row.created_at_ms,
                            data: eventData,
                            id: row.event_id,
                            sessionId: share.ownerSessionId,
                            type: row.type,
                        } as SessionEvent,
                        kind: "event",
                    },
                    toolOutput,
                });
                if (projected === undefined) {
                    publishedEventSeq = row.seq;
                    progressed += 1;
                    continue;
                }
                const byteLength = Buffer.byteLength(projected.canonicalJson, "utf8");
                if (
                    outboxCount + 1 > input.maxOutboxCount ||
                    outboxBytes + byteLength > input.maxOutboxBytes
                ) {
                    degraded = true;
                    break;
                }
                tx.insert(sessionShareOutbox)
                    .values({
                        byteLength,
                        canonicalJson: projected.canonicalJson,
                        contentHash: projected.contentHash,
                        createdAtMs: projected.createdAt,
                        sequence: nextSequence,
                        shareEventId: projected.shareEventId,
                        shareId: input.shareId,
                        sourceEventSeq: row.seq,
                    })
                    .run();
                appended += 1;
                progressed += 1;
                nextSequence += 1;
                outboxBytes += byteLength;
                outboxCount += 1;
                publishedEventSeq = row.seq;
            }
        }
        tx.update(sessionShares)
            .set({
                nextShareSequence: nextSequence,
                outboxBytes,
                outboxCount,
                publishedEventSeq,
                publishedMessagePosition,
                state: degraded ? "degraded" : share.state,
                updatedAtMs: input.now,
            })
            .where(eq(sessionShares.shareId, input.shareId))
            .run();
        return { appended, degraded, progressed, publishedEventSeq };
    });
}

function messageWasIncludedInSnapshot(
    tx: TX,
    sessionId: string,
    data: Record<string, unknown>,
    snapshotBoundary: number,
): boolean {
    const message = data.message;
    if (message === null || typeof message !== "object") return false;
    const messageId = (message as Record<string, unknown>).id;
    if (typeof messageId !== "string") return false;
    const row = tx.get<{ position: number }>(sql`
        SELECT position
        FROM session_share_snapshot_messages
        WHERE share_id = (
            SELECT share_id
            FROM session_shares
            WHERE owner_session_id = ${sessionId}
              AND state <> 'stopped'
            ORDER BY created_at_ms DESC, share_id DESC
            LIMIT 1
        )
          AND message_id = ${messageId}
        LIMIT 1
    `);
    return row !== undefined && row.position <= snapshotBoundary;
}
