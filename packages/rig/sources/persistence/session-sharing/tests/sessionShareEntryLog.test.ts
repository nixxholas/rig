import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ShareOpaqueEntry } from "../../../sharing/ShareTransport.js";
import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { querySessionShareEntryLog } from "../querySessionShareEntryLog.js";
import { querySessionShareOutbox } from "../querySessionShareOutbox.js";
import { sessionShareCreate } from "../sessionShareCreate.js";
import { sessionShareEntryLogAppend } from "../sessionShareEntryLogAppend.js";
import { sessionShareOutboxAcknowledge } from "../sessionShareOutboxAcknowledge.js";
import { sessionShareOutboxEnqueue } from "../sessionShareOutboxEnqueue.js";
import { sessionShareStop } from "../sessionShareStop.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("session share entry log persistence", () => {
    it("retains entries once the outbox that produced them is acknowledged", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            sessionShareOutboxEnqueue(opened.database, {
                byteLength: 9,
                canonicalJson: '{"one":1}',
                contentHash: "hash-1",
                createdAt: 2,
                degradeAboveBytes: 1_000,
                degradeAboveCount: 1_000,
                shareEventId: "event-1",
                shareId: "share-1",
            });
            sessionShareOutboxEnqueue(opened.database, {
                byteLength: 9,
                canonicalJson: '{"two":2}',
                contentHash: "hash-2",
                createdAt: 3,
                degradeAboveBytes: 1_000,
                degradeAboveCount: 1_000,
                shareEventId: "event-2",
                shareId: "share-1",
            });

            sessionShareOutboxAcknowledge(opened.database, {
                now: 4,
                shareId: "share-1",
                throughSequence: 2,
            });

            expect(
                querySessionShareOutbox(opened.database, { limit: 10, shareId: "share-1" }),
            ).toEqual([]);
            expect(
                querySessionShareEntryLog(opened.database, {
                    afterSequence: 0,
                    maxBytes: 1_000,
                    maxItems: 10,
                    shareId: "share-1",
                }),
            ).toEqual({
                complete: true,
                entries: [
                    {
                        canonicalJson: '{"one":1}',
                        contentHash: "hash-1",
                        createdAt: 2,
                        shareEventId: "event-1",
                        shareId: "share-1",
                        shareSequence: 1,
                    },
                    {
                        canonicalJson: '{"two":2}',
                        contentHash: "hash-2",
                        createdAt: 3,
                        shareEventId: "event-2",
                        shareId: "share-1",
                        shareSequence: 2,
                    },
                ],
            });
        } finally {
            opened.client.close();
        }
    });

    it("prunes the whole log when the share stops so no transcript duplicate lingers", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            sessionShareEntryLogAppend(opened.database, {
                entries: [logEntry(1), logEntry(2), logEntry(3)],
                shareId: "share-1",
            });
            expect(
                querySessionShareEntryLog(opened.database, {
                    afterSequence: 0,
                    maxBytes: 1_000,
                    maxItems: 10,
                    shareId: "share-1",
                }).entries,
            ).toHaveLength(3);

            expect(sessionShareStop(opened.database, "share-1", 5)).toBe(true);

            // Stopping flips state only, so the CASCADE never fires; the stop must
            // prune the log itself. A stopped share can never offer history again.
            expect(
                querySessionShareEntryLog(opened.database, {
                    afterSequence: 0,
                    maxBytes: 1_000,
                    maxItems: 10,
                    shareId: "share-1",
                }).entries,
            ).toEqual([]);
        } finally {
            opened.client.close();
        }
    });

    it("keeps re-appending the same entry a no-op and rejects conflicting content", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            const entry = logEntry(1, { canonicalJson: '{"a":1}', contentHash: "hash-a" });

            expect(() =>
                sessionShareEntryLogAppend(opened.database, {
                    entries: [entry],
                    shareId: "share-1",
                }),
            ).not.toThrow();
            expect(() =>
                sessionShareEntryLogAppend(opened.database, {
                    entries: [entry],
                    shareId: "share-1",
                }),
            ).not.toThrow();
            expect(
                querySessionShareEntryLog(opened.database, {
                    afterSequence: 0,
                    maxBytes: 1_000,
                    maxItems: 10,
                    shareId: "share-1",
                }).entries,
            ).toHaveLength(1);

            expect(() =>
                sessionShareEntryLogAppend(opened.database, {
                    entries: [
                        logEntry(1, { canonicalJson: '{"a":2}', contentHash: "hash-different" }),
                    ],
                    shareId: "share-1",
                }),
            ).toThrow("already has different content");
        } finally {
            opened.client.close();
        }
    });

    it("stores entries gaplessly and ordered as sequences arrive out of order", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            sessionShareEntryLogAppend(opened.database, {
                entries: [logEntry(3), logEntry(1), logEntry(2)],
                shareId: "share-1",
            });

            expect(
                querySessionShareEntryLog(opened.database, {
                    afterSequence: 0,
                    maxBytes: 1_000,
                    maxItems: 10,
                    shareId: "share-1",
                }).entries.map((entry) => entry.shareSequence),
            ).toEqual([1, 2, 3]);
        } finally {
            opened.client.close();
        }
    });

    it("pages by item and byte limits and reports completeness accurately", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            const entries = [1, 2, 3, 4].map((sequence) =>
                logEntry(sequence, {
                    canonicalJson: JSON.stringify({ padding: "x".repeat(10), sequence }),
                }),
            );
            sessionShareEntryLogAppend(opened.database, { entries, shareId: "share-1" });
            const byteLength = Buffer.byteLength(entries[0]!.canonicalJson, "utf8");

            const firstPage = querySessionShareEntryLog(opened.database, {
                afterSequence: 0,
                maxBytes: 1_000,
                maxItems: 2,
                shareId: "share-1",
            });
            expect(firstPage.complete).toBe(false);
            expect(firstPage.entries.map((entry) => entry.shareSequence)).toEqual([1, 2]);

            const secondPage = querySessionShareEntryLog(opened.database, {
                afterSequence: 2,
                maxBytes: 1_000,
                maxItems: 10,
                shareId: "share-1",
            });
            expect(secondPage.complete).toBe(true);
            expect(secondPage.entries.map((entry) => entry.shareSequence)).toEqual([3, 4]);

            const byteBounded = querySessionShareEntryLog(opened.database, {
                afterSequence: 0,
                maxBytes: byteLength + 1,
                maxItems: 10,
                shareId: "share-1",
            });
            expect(byteBounded.complete).toBe(false);
            expect(byteBounded.entries.map((entry) => entry.shareSequence)).toEqual([1]);
        } finally {
            opened.client.close();
        }
    });

    it("still returns a single entry that alone exceeds the byte budget", async () => {
        const opened = await fixture();
        try {
            createShare(opened.database);
            const oversized = logEntry(1, {
                canonicalJson: JSON.stringify({ padding: "x".repeat(1_000) }),
            });
            sessionShareEntryLogAppend(opened.database, {
                entries: [oversized],
                shareId: "share-1",
            });

            const page = querySessionShareEntryLog(opened.database, {
                afterSequence: 0,
                maxBytes: 10,
                maxItems: 10,
                shareId: "share-1",
            });
            expect(page.entries).toHaveLength(1);
            expect(page.complete).toBe(true);
        } finally {
            opened.client.close();
        }
    });
});

function logEntry(sequence: number, overrides: Partial<ShareOpaqueEntry> = {}): ShareOpaqueEntry {
    return {
        canonicalJson: `{"sequence":${String(sequence)}}`,
        contentHash: `hash-${String(sequence)}`,
        createdAt: sequence,
        shareEventId: `event-${String(sequence)}`,
        shareId: "share-1",
        shareSequence: sequence,
        ...overrides,
    };
}

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
        toolOutput: "summaries",
    });
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "rig-session-share-entry-log-"));
    directories.push(directory);
    const path = join(directory, "sessions.sqlite");
    createSessionDatabaseFixture(path);
    return { ...openSessionDatabase(path), databasePath: path };
}
