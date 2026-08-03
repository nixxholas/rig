import { sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import { createEventIdFactory } from "../../protocol/createEventIdFactory.js";
import { projectSessionShareEntry } from "../../session-sharing/projectSessionShareEntry.js";
import {
    sessionShareGrants,
    sessionShareMembers,
    sessionShareOutbox,
    sessionShares,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { SessionShareRecord } from "./types.js";

export function sessionShareCreate(
    tx: TX,
    input: {
        includeFriendMessages: boolean;
        members: readonly {
            displayName: string;
            murmurPeerId: string;
            shareMemberId: string;
        }[];
        now: number;
        maxOutboxBytes?: number;
        maxOutboxCount?: number;
        ownerPeerId: string;
        ownerSessionId: string;
        shareId: string;
    },
): SessionShareRecord {
    return inTx(tx, (tx) => {
        if (input.members.length === 0) {
            throw new Error("A session share needs at least one member.");
        }
        const session = tx.get<Record<string, unknown>>(sql`
            SELECT last_event_id
            FROM sessions
            WHERE id = ${input.ownerSessionId}
        `);
        if (session === undefined) throw new Error("The owner session does not exist.");
        const snapshotThroughPosition =
            tx.get<{ position: number | null }>(sql`
            SELECT MAX(position) AS position
            FROM session_messages
            WHERE session_id = ${input.ownerSessionId} AND is_partial = 0
        `)?.position ?? undefined;
        const maxBytes = input.maxOutboxBytes ?? 64 * 1024 * 1024;
        const maxCount = input.maxOutboxCount ?? 100_000;
        const seedLimit = Math.max(1, Math.min(maxCount + 1, 1_000));
        const messages = tx.all<{
            message_json: string;
            position: number;
            run_id: string | null;
            updated_at_ms: number;
        }>(sql`
            SELECT message_json, position, run_id, updated_at_ms
            FROM session_messages
            WHERE session_id = ${input.ownerSessionId} AND is_partial = 0
            ORDER BY position ASC
            LIMIT ${seedLimit}
        `);
        const snapshotThroughEventId =
            typeof session.last_event_id === "string" ? session.last_event_id : undefined;
        const createShareEventId = createEventIdFactory({ now: () => input.now });
        let outboxBytes = 0;
        let outboxCount = 0;
        let nextShareSequence = 1;
        let publishedMessagePosition = -1;
        let degraded = false;
        const entries: {
            byteLength: number;
            projected: NonNullable<ReturnType<typeof projectSessionShareEntry>>;
        }[] = [];
        for (const row of messages) {
            const projected = projectSessionShareEntry({
                createdAt: row.updated_at_ms,
                shareEventId: createShareEventId(),
                shareId: input.shareId,
                shareSequence: nextShareSequence,
                source: {
                    kind: "message",
                    message: JSON.parse(row.message_json) as Message,
                    position: row.position,
                    ...(row.run_id === null ? {} : { runId: row.run_id }),
                },
            });
            if (projected === undefined) {
                publishedMessagePosition = row.position;
                continue;
            }
            const byteLength = Buffer.byteLength(projected.canonicalJson, "utf8");
            if (outboxCount + 1 > maxCount || outboxBytes + byteLength > maxBytes) {
                degraded = true;
                break;
            }
            outboxBytes += byteLength;
            outboxCount += 1;
            nextShareSequence += 1;
            publishedMessagePosition = row.position;
            entries.push({ byteLength, projected });
        }
        tx.insert(sessionShares)
            .values({
                createdAtMs: input.now,
                includeFriendMessages: input.includeFriendMessages,
                nextShareSequence,
                outboxBytes,
                outboxCount,
                ownerPeerId: input.ownerPeerId,
                ownerSessionId: input.ownerSessionId,
                publishedEventSeq: 0,
                publishedMessagePosition,
                shareId: input.shareId,
                snapshotThroughEventId: snapshotThroughEventId ?? null,
                snapshotThroughPosition: snapshotThroughPosition ?? null,
                state: degraded ? "degraded" : "active",
                updatedAtMs: input.now,
            })
            .run();
        for (const { byteLength, projected } of entries) {
            tx.insert(sessionShareOutbox)
                .values({
                    byteLength,
                    canonicalJson: projected.canonicalJson,
                    contentHash: projected.contentHash,
                    createdAtMs: projected.createdAt,
                    sequence: projected.shareSequence,
                    shareEventId: projected.shareEventId,
                    shareId: projected.shareId,
                })
                .run();
        }
        for (const member of input.members) {
            tx.insert(sessionShareMembers)
                .values({
                    createdAtMs: input.now,
                    currentGrantEpoch: 1,
                    displayName: member.displayName,
                    murmurPeerId: member.murmurPeerId,
                    shareId: input.shareId,
                    shareMemberId: member.shareMemberId,
                    state: "active",
                    updatedAtMs: input.now,
                })
                .run();
            tx.insert(sessionShareGrants)
                .values({
                    createdAtMs: input.now,
                    grantEpoch: 1,
                    shareMemberId: member.shareMemberId,
                    state: "active",
                })
                .run();
        }
        return {
            createdAt: input.now,
            includeFriendMessages: input.includeFriendMessages,
            nextShareSequence,
            outboxBytes,
            outboxCount,
            ownerPeerId: input.ownerPeerId,
            ownerSessionId: input.ownerSessionId,
            publishedEventSeq: 0,
            publishedMessagePosition,
            shareId: input.shareId,
            ...(snapshotThroughEventId === undefined ? {} : { snapshotThroughEventId }),
            ...(snapshotThroughPosition === undefined ? {} : { snapshotThroughPosition }),
            state: degraded ? "degraded" : "active",
            updatedAt: input.now,
        };
    });
}
