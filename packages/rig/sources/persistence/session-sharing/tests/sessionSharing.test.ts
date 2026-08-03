import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import {
    sessionMessages,
    sessionEvents,
    sessionShareGrants,
    sessionShareMessageContext,
    sessions,
} from "../../database/schema.js";
import { querySessionShare, querySessionShareMembers } from "../querySessionShare.js";
import { querySessionShareFriendMessages } from "../querySessionShareFriendMessages.js";
import { querySessionShareOutbox } from "../querySessionShareOutbox.js";
import {
    querySessionShareReplica,
    querySessionShareReplicaEntries,
} from "../querySessionShareReplica.js";
import { sessionShareCreate } from "../sessionShareCreate.js";
import { sessionShareFriendMessageSave } from "../sessionShareFriendMessageSave.js";
import { sessionShareGrant } from "../sessionShareGrant.js";
import { sessionShareMessageContextSet } from "../sessionShareMessageContextSet.js";
import { sessionShareOutboxAcknowledge } from "../sessionShareOutboxAcknowledge.js";
import { sessionShareOutboxEnqueue } from "../sessionShareOutboxEnqueue.js";
import { sessionShareReplicaAppend } from "../sessionShareReplicaAppend.js";
import { sessionShareReplicaEndCurrentGrant } from "../sessionShareReplicaEndCurrentGrant.js";
import { sessionShareReplicaSave } from "../sessionShareReplicaSave.js";
import { sessionShareRevoke } from "../sessionShareRevoke.js";
import { sessionShareStop } from "../sessionShareStop.js";
import { sessionShareSetIncludeFriendMessages } from "../sessionShareSetIncludeFriendMessages.js";
import { sessionShareTailEvents } from "../sessionShareTailEvents.js";
import { sessionShareAcceptFriendMessage } from "../sessionShareAcceptFriendMessage.js";
import { sessionDrainFriendContextMessages } from "../sessionDrainFriendContextMessages.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("session sharing persistence", () => {
    it("keeps friend backlog pending while off, then drains newest with explicit overflow", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            const granted = sessionShareGrant(opened.database, {
                displayName: "Friend",
                murmurPeerId: "peer-friend",
                now: 2,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            sessionShareSetIncludeFriendMessages(opened.database, "share-1", false, 2);
            for (let index = 1; index <= 2; index += 1) {
                const message = {
                    blocks: [{ text: `friend-${String(index)}`, type: "text" as const }],
                    contextOnly: true as const,
                    friendAuthor: {
                        displayName: "Friend",
                        grantEpoch: granted.currentGrantEpoch,
                        kind: "friend" as const,
                        murmurPeerId: "peer-friend",
                        shareId: "share-1",
                        shareMemberId: granted.shareMemberId,
                    },
                    id: `friend-${String(index)}`,
                    role: "user" as const,
                };
                sessionShareAcceptFriendMessage(opened.database, {
                    message,
                    now: 2 + index,
                    post: {
                        clientMessageId: `client-${String(index)}`,
                        displayName: "Friend",
                        grant: {
                            grantEpoch: granted.currentGrantEpoch,
                            murmurPeerId: "peer-friend",
                            shareId: "share-1",
                            shareMemberId: granted.shareMemberId,
                        },
                        text: `friend-${String(index)}`,
                    },
                    senderPeerId: "peer-friend",
                });
            }
            expect(
                sessionDrainFriendContextMessages(opened.database, {
                    limits: { maxBytes: 100, maxEstimatedTokens: 100, maxMessages: 1 },
                    now: 5,
                    runId: "run-off",
                    sessionId: "session-1",
                }),
            ).toEqual({
                enabled: false,
                messages: [],
                omittedCount: 0,
                omittedMessageIds: [],
            });
            expect(
                querySessionShareFriendMessages(opened.database, {
                    disposition: "pending",
                    shareId: "share-1",
                }),
            ).toHaveLength(2);
            expect(
                opened.database
                    .select()
                    .from(sessionEvents)
                    .where(eq(sessionEvents.type, "message_submitted"))
                    .all(),
            ).toHaveLength(2);

            sessionShareSetIncludeFriendMessages(opened.database, "share-1", true, 6);
            const drained = sessionDrainFriendContextMessages(opened.database, {
                limits: { maxBytes: 100, maxEstimatedTokens: 100, maxMessages: 1 },
                now: 7,
                runId: "run-on",
                sessionId: "session-1",
            });
            expect(drained.messages.map((entry) => entry.message.id)).toEqual(["friend-2"]);
            expect(drained.omittedMessageIds).toEqual(["friend-1"]);
            expect(
                querySessionShareFriendMessages(opened.database, { shareId: "share-1" }).map(
                    (entry) => [entry.messageId, entry.disposition, entry.includedRunId],
                ),
            ).toEqual([
                ["friend-1", "overflow", undefined],
                ["friend-2", "included", "run-on"],
            ]);
        } finally {
            opened.client.close();
        }
    });

    it("creates grants append-only, revokes them, and stops the complete share atomically", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            const first = sessionShareGrant(opened.database, {
                displayName: "Friend",
                murmurPeerId: "peer-friend",
                now: 2,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(
                sessionShareGrant(opened.database, {
                    displayName: "Ignored retry",
                    murmurPeerId: "peer-friend",
                    now: 3,
                    shareId: "share-1",
                    shareMemberId: "different-id",
                }),
            ).toEqual(first);
            expect(
                sessionShareRevoke(opened.database, {
                    now: 4,
                    shareId: "share-1",
                    shareMemberId: "member-1",
                }),
            ).toBe(true);
            expect(
                sessionShareGrant(opened.database, {
                    displayName: "Friend again",
                    murmurPeerId: "peer-friend",
                    now: 5,
                    shareId: "share-1",
                    shareMemberId: "unused-id",
                }),
            ).toMatchObject({ currentGrantEpoch: 2, shareMemberId: "member-1" });
            expect(
                opened.database
                    .select()
                    .from(sessionShareGrants)
                    .where(eq(sessionShareGrants.shareMemberId, "member-1"))
                    .all(),
            ).toMatchObject([
                { grantEpoch: 1, state: "revoked" },
                { grantEpoch: 2, state: "active" },
            ]);
            expect(sessionShareStop(opened.database, "share-1", 6)).toBe(true);
            expect(sessionShareStop(opened.database, "share-1", 7)).toBe(false);
            expect(querySessionShare(opened.database, "share-1")).toMatchObject({
                state: "stopped",
                stoppedAt: 6,
            });
            expect(querySessionShareMembers(opened.database, "share-1")).toContainEqual(
                expect.objectContaining({
                    currentGrantEpoch: 2,
                    shareMemberId: "member-1",
                    state: "stopped",
                }),
            );
            sessionShareCreate(opened.database, {
                includeFriendMessages: false,
                members: [
                    {
                        displayName: "New friend",
                        murmurPeerId: "peer-new",
                        shareMemberId: "member-new",
                    },
                ],
                now: 8,
                ownerPeerId: "peer-owner",
                ownerSessionId: "session-1",
                shareId: "share-2",
            });
            expect(querySessionShare(opened.database, "share-2")).toMatchObject({
                includeFriendMessages: false,
                state: "active",
            });
        } finally {
            opened.client.close();
        }
    });

    it("pages and acknowledges an idempotent outbox while keeping exact counters", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            const first = sessionShareOutboxEnqueue(opened.database, {
                byteLength: 10,
                canonicalJson: '{"one":1}',
                contentHash: "hash-1",
                createdAt: 2,
                degradeAboveBytes: 15,
                degradeAboveCount: 10,
                shareEventId: "event-1",
                shareId: "share-1",
            });
            expect(
                sessionShareOutboxEnqueue(opened.database, {
                    byteLength: 999,
                    canonicalJson: "retry",
                    contentHash: "retry",
                    createdAt: 3,
                    degradeAboveBytes: 15,
                    degradeAboveCount: 10,
                    shareEventId: "event-1",
                    shareId: "share-1",
                }),
            ).toEqual(first);
            expect(
                sessionShareOutboxEnqueue(opened.database, {
                    byteLength: 8,
                    canonicalJson: '{"two":2}',
                    contentHash: "hash-2",
                    createdAt: 4,
                    degradeAboveBytes: 15,
                    degradeAboveCount: 10,
                    shareEventId: "event-2",
                    shareId: "share-1",
                }),
            ).toBeUndefined();
            expect(querySessionShare(opened.database, "share-1")).toMatchObject({
                nextShareSequence: 2,
                outboxBytes: 10,
                outboxCount: 1,
                state: "degraded",
            });
            expect(
                querySessionShareOutbox(opened.database, {
                    afterSequence: 1,
                    limit: 10,
                    shareId: "share-1",
                }).map((entry) => entry.shareEventId),
            ).toEqual([]);
            sessionShareOutboxAcknowledge(opened.database, {
                now: 5,
                shareId: "share-1",
                throughSequence: 1,
            });
            expect(querySessionShare(opened.database, "share-1")).toMatchObject({
                outboxBytes: 0,
                outboxCount: 0,
                publishedEventSeq: 0,
            });
        } finally {
            opened.client.close();
        }
    });

    it("deduplicates friend messages with their context in one transaction", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            sessionShareGrant(opened.database, {
                displayName: "Friend",
                murmurPeerId: "peer-friend",
                now: 2,
                shareId: "share-1",
                shareMemberId: "member-1",
            });
            expect(sessionShareSetIncludeFriendMessages(opened.database, "share-1", false, 2)).toBe(
                true,
            );
            opened.database
                .insert(sessionMessages)
                .values({
                    isPartial: false,
                    messageId: "message-1",
                    messageJson: '{"id":"message-1","role":"user","blocks":[]}',
                    position: 0,
                    role: "user",
                    sessionId: "session-1",
                    updatedAtMs: 3,
                })
                .run();
            const saved = sessionShareFriendMessageSave(opened.database, {
                byteEstimate: 20,
                clientMessageId: "client-1",
                createdAt: 3,
                displayName: "Friend",
                grantEpoch: 1,
                messageId: "message-1",
                murmurPeerId: "peer-friend",
                ownerPosition: 0,
                ownerSessionId: "session-1",
                shareId: "share-1",
                shareMemberId: "member-1",
                tokenEstimate: 5,
            });
            expect(
                sessionShareFriendMessageSave(opened.database, {
                    ...saved,
                    byteEstimate: 999,
                    displayName: "Friend",
                    murmurPeerId: "peer-friend",
                    tokenEstimate: 999,
                }),
            ).toEqual(saved);
            expect(() =>
                sessionShareFriendMessageSave(opened.database, {
                    ...saved,
                    byteEstimate: 20,
                    clientMessageId: "client-spoofed-name",
                    displayName: "Impostor",
                    messageId: "message-spoofed-name",
                    murmurPeerId: "peer-friend",
                    tokenEstimate: 5,
                }),
            ).toThrow("current share grant");
            expect(
                querySessionShareFriendMessages(opened.database, { shareId: "share-1" }),
            ).toMatchObject([{ disposition: "pending", messageId: "message-1" }]);
            expect(
                sessionShareMessageContextSet(opened.database, {
                    disposition: "included",
                    includedRunId: "run-1",
                    messageId: "message-1",
                    now: 4,
                }),
            ).toBe(true);
            expect(
                opened.database
                    .select()
                    .from(sessionShareMessageContext)
                    .where(eq(sessionShareMessageContext.messageId, "message-1"))
                    .get(),
            ).toMatchObject({ disposition: "included", includedRunId: "run-1" });
        } finally {
            opened.client.close();
        }
    });

    it("seeds a canonical snapshot and tails each durable event exactly once across overflow", async () => {
        const opened = await fixture();
        try {
            opened.database
                .insert(sessionMessages)
                .values({
                    isPartial: false,
                    messageId: "snapshot-message",
                    messageJson:
                        '{"id":"snapshot-message","role":"user","blocks":[{"type":"text","text":"Snapshot"}]}',
                    position: 0,
                    role: "user",
                    sessionId: "session-1",
                    updatedAtMs: 1,
                })
                .run();
            const firstEvent = opened.database
                .insert(sessionEvents)
                .values({
                    createdAtMs: 1,
                    dataJson:
                        '{"event":{"action":"write files","decision":"deny","reason":"Not authorized","risk":"high","toolCallId":"call-1","type":"permission_review","userAuthorization":"unknown"},"runId":"run-1"}',
                    eventId: "source-event-1",
                    sessionId: "session-1",
                    type: "agent_event",
                })
                .returning({ seq: sessionEvents.seq })
                .get();
            opened.database
                .update(sessions)
                .set({ lastEventId: "source-event-1" })
                .where(eq(sessions.id, "session-1"))
                .run();
            createShare(opened.database);
            expect(querySessionShare(opened.database, "share-1")).toMatchObject({
                nextShareSequence: 2,
                outboxCount: 1,
                publishedEventSeq: 0,
                publishedMessagePosition: 0,
                snapshotThroughEventId: "source-event-1",
                snapshotThroughPosition: 0,
            });
            const secondEvent = opened.database
                .insert(sessionEvents)
                .values({
                    createdAtMs: 2,
                    dataJson: '{"status":"running"}',
                    eventId: "source-event-2",
                    sessionId: "session-1",
                    type: "session_status_changed",
                })
                .returning({ seq: sessionEvents.seq })
                .get();
            expect(
                sessionShareTailEvents(opened.database, {
                    maxOutboxBytes: 64 * 1024,
                    maxOutboxCount: 1,
                    now: 3,
                    pageSize: 10,
                    shareId: "share-1",
                }),
            ).toEqual({
                appended: 0,
                degraded: true,
                publishedEventSeq: 0,
            });
            sessionShareOutboxAcknowledge(opened.database, {
                now: 4,
                shareId: "share-1",
                throughSequence: 1,
            });
            expect(
                sessionShareTailEvents(opened.database, {
                    maxOutboxBytes: 64 * 1024,
                    maxOutboxCount: 1,
                    now: 5,
                    pageSize: 10,
                    shareId: "share-1",
                }),
            ).toEqual({
                appended: 1,
                degraded: true,
                publishedEventSeq: firstEvent.seq,
            });
            expect(
                querySessionShareOutbox(opened.database, { limit: 10, shareId: "share-1" }),
            ).toMatchObject([{ sequence: 2, sourceEventSeq: firstEvent.seq }]);
            expect(
                querySessionShareOutbox(opened.database, { limit: 10, shareId: "share-1" })[0]
                    ?.canonicalJson,
            ).toContain("permission_review");
            sessionShareOutboxAcknowledge(opened.database, {
                now: 6,
                shareId: "share-1",
                throughSequence: 2,
            });
            expect(
                sessionShareTailEvents(opened.database, {
                    maxOutboxBytes: 64 * 1024,
                    maxOutboxCount: 1,
                    now: 7,
                    pageSize: 10,
                    shareId: "share-1",
                }),
            ).toEqual({
                appended: 1,
                degraded: false,
                publishedEventSeq: secondEvent.seq,
            });
        } finally {
            opened.client.close();
        }
    });

    it("resumes an over-bound snapshot from its durable message position after reopening", async () => {
        const opened = await fixture();
        const databasePath = opened.databasePath;
        for (const [position, text] of ["First", "Second"].entries()) {
            opened.database
                .insert(sessionMessages)
                .values({
                    isPartial: false,
                    messageId: `snapshot-${String(position)}`,
                    messageJson: JSON.stringify({
                        blocks: [{ text, type: "text" }],
                        id: `snapshot-${String(position)}`,
                        role: "user",
                    }),
                    position,
                    role: "user",
                    sessionId: "session-1",
                    updatedAtMs: position + 1,
                })
                .run();
        }
        sessionShareCreate(opened.database, {
            includeFriendMessages: true,
            maxOutboxCount: 1,
            members: [
                {
                    displayName: "Initial friend",
                    murmurPeerId: "peer-initial",
                    shareMemberId: "member-initial",
                },
            ],
            now: 3,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            shareId: "share-1",
        });
        expect(querySessionShare(opened.database, "share-1")).toMatchObject({
            publishedMessagePosition: 0,
            snapshotThroughPosition: 1,
            state: "degraded",
        });
        opened.client.close();

        const restored = openSessionDatabase(databasePath);
        try {
            sessionShareOutboxAcknowledge(restored.database, {
                now: 4,
                shareId: "share-1",
                throughSequence: 1,
            });
            expect(
                sessionShareTailEvents(restored.database, {
                    maxOutboxBytes: 64 * 1024,
                    maxOutboxCount: 1,
                    now: 5,
                    pageSize: 1,
                    shareId: "share-1",
                }),
            ).toMatchObject({ appended: 1, degraded: false, publishedEventSeq: 0 });
            expect(querySessionShare(restored.database, "share-1")).toMatchObject({
                publishedMessagePosition: 1,
                snapshotThroughPosition: 1,
            });
            expect(
                querySessionShareOutbox(restored.database, { limit: 10, shareId: "share-1" }),
            ).toMatchObject([{ sequence: 2 }]);
        } finally {
            restored.client.close();
        }
    });

    it("appends replica entries only for the current grant and deletes them when it ends", async () => {
        const opened = await fixture();
        try {
            sessionShareReplicaSave(opened.database, {
                createdAt: 1,
                grantEpoch: 2,
                memberCount: 3,
                murmurPeerId: "member-peer",
                ownerPeerId: "owner-peer",
                shareId: "remote-share",
                shareMemberId: "remote-member",
                state: "active",
                title: "Shared work",
                updatedAt: 1,
            });
            const append = {
                canonicalJson: '{"event":1}',
                contentHash: "hash",
                createdAt: 2,
                grantEpoch: 2,
                grantMemberId: "remote-member",
                sequence: 1,
                shareEventId: "remote-event",
                shareId: "remote-share",
            };
            expect(sessionShareReplicaAppend(opened.database, append)).toBe(true);
            expect(sessionShareReplicaAppend(opened.database, append)).toBe(false);
            expect(querySessionShareReplicaEntries(opened.database, "remote-share")).toHaveLength(
                1,
            );
            sessionShareReplicaSave(opened.database, {
                createdAt: 1,
                grantEpoch: 3,
                memberCount: 3,
                murmurPeerId: "member-peer",
                ownerPeerId: "owner-peer",
                shareId: "remote-share",
                shareMemberId: "remote-member",
                state: "active",
                title: "Shared work",
                updatedAt: 3,
            });
            expect(querySessionShareReplicaEntries(opened.database, "remote-share")).toEqual([]);
            expect(
                sessionShareReplicaEndCurrentGrant(opened.database, {
                    grantEpoch: 2,
                    now: 3,
                    reason: "revoked",
                    shareId: "remote-share",
                    shareMemberId: "remote-member",
                }),
            ).toBe(false);
            expect(querySessionShareReplica(opened.database, "remote-share")).toMatchObject({
                murmurPeerId: "member-peer",
                state: "active",
            });
            expect(querySessionShareReplicaEntries(opened.database, "remote-share")).toEqual([]);
        } finally {
            opened.client.close();
        }
    });
});

function createShare(tx: Parameters<typeof sessionShareCreate>[0]): void {
    sessionShareCreate(tx, {
        includeFriendMessages: true,
        members: [
            {
                displayName: "Initial friend",
                murmurPeerId: "peer-initial",
                shareMemberId: "member-initial",
            },
        ],
        now: 1,
        ownerPeerId: "peer-owner",
        ownerSessionId: "session-1",
        shareId: "share-1",
    });
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "rig-session-sharing-"));
    directories.push(directory);
    const path = join(directory, "sessions.sqlite");
    createSessionDatabaseFixture(path);
    return { ...openSessionDatabase(path), databasePath: path };
}
