import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    projectScopeShareEntry,
    type ScopeShareProjection,
} from "../../../scope-sharing/projectScopeShareEntry.js";
import type { SessionDatabase } from "../../database/openSessionDatabase.js";
import {
    queryScopeShareReplica,
    queryScopeShareReplicaEntries,
    queryScopeShareReplicas,
} from "../queryScopeShareReplica.js";
import { scopeShareReplicaAppend } from "../scopeShareReplicaAppend.js";
import { scopeShareReplicaEndCurrentGrant } from "../scopeShareReplicaEndCurrentGrant.js";
import { scopeShareReplicaSave } from "../scopeShareReplicaSave.js";
import { createScopeShareFixture } from "./createScopeShareFixture.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("scope share replicas", () => {
    it("advances the applied watermark only over a contiguous run", () => {
        const fixture = openFixture();
        try {
            saveReplica(fixture.database);

            append(fixture.database, { sequence: 1 });
            append(fixture.database, { sequence: 3 });
            const withGap = queryScopeShareReplica(fixture.database, "share-1");
            append(fixture.database, { sequence: 2 });
            const filled = queryScopeShareReplica(fixture.database, "share-1");

            // A member may receive out of order, but it may never show a hole as if it
            // were the end of the transcript.
            expect(withGap?.appliedThroughSequence).toBe(1);
            expect(filled?.appliedThroughSequence).toBe(3);
            expect(
                queryScopeShareReplicaEntries(fixture.database, "share-1").map(
                    (entry) => entry.sequence,
                ),
            ).toEqual([1, 2, 3]);
        } finally {
            fixture.close();
        }
    });

    it("tags each replicated entry so one session can be paged out of the scope's log", () => {
        const fixture = openFixture();
        try {
            saveReplica(fixture.database);

            append(fixture.database, { sequence: 1, sessionId: "session-a" });
            append(fixture.database, { sequence: 2, sessionId: "session-b" });
            append(fixture.database, { sequence: 3, sessionId: "session-a" });

            expect(
                queryScopeShareReplicaEntries(fixture.database, "share-1", {
                    subjectId: "session-a",
                    subjectKind: "session_index",
                }).map((entry) => entry.sequence),
            ).toEqual([1, 3]);
        } finally {
            fixture.close();
        }
    });

    it("ignores a repeated entry and refuses a conflicting one", () => {
        const fixture = openFixture();
        try {
            saveReplica(fixture.database);
            append(fixture.database, { sequence: 1 });

            expect(append(fixture.database, { sequence: 1 })).toBe(false);
            expect(() => append(fixture.database, { sequence: 1, sessionId: "other" })).toThrow(
                /conflicts/,
            );
        } finally {
            fixture.close();
        }
    });

    it("retires the entries when the owner removes the member but not when a frame is unreadable", () => {
        const fixture = openFixture();
        try {
            saveReplica(fixture.database);
            append(fixture.database, { sequence: 1 });

            const unreadable = scopeShareReplicaEndCurrentGrant(fixture.database, {
                grantEpoch: 1,
                now: 8,
                pruneEntries: false,
                reason: "unreadable",
                shareId: "share-1",
                shareMemberId: "member-1",
            });

            expect(unreadable).toBe(true);
            expect(queryScopeShareReplicaEntries(fixture.database, "share-1")).toHaveLength(1);
            expect(queryScopeShareReplica(fixture.database, "share-1")?.endedReason).toBe(
                "unreadable",
            );

            saveReplica(fixture.database, { grantEpoch: 2 });
            append(fixture.database, { grantEpoch: 2, sequence: 1 });
            scopeShareReplicaEndCurrentGrant(fixture.database, {
                grantEpoch: 2,
                now: 9,
                pruneEntries: true,
                reason: "revoked",
                shareId: "share-1",
                shareMemberId: "member-1",
            });

            expect(queryScopeShareReplicaEntries(fixture.database, "share-1")).toEqual([]);
            expect(
                queryScopeShareReplicas(fixture.database).map((replica) => replica.state),
            ).toEqual(["ended"]);
        } finally {
            fixture.close();
        }
    });

    it("refuses an entry whose content hash does not match", () => {
        const fixture = openFixture();
        try {
            saveReplica(fixture.database);
            const entry = replicaEntry({ sequence: 1 });

            expect(() =>
                scopeShareReplicaAppend(fixture.database, {
                    ...entry,
                    contentHash: "not-the-hash",
                    grantEpoch: 1,
                    grantMemberId: "member-1",
                    grantShareId: "share-1",
                }),
            ).toThrow(/content hash/);
        } finally {
            fixture.close();
        }
    });
});

function openFixture(): { close: () => void; database: SessionDatabase } {
    const directory = mkdtempSync(join(tmpdir(), "scope-share-replica-"));
    directories.push(directory);
    return createScopeShareFixture(join(directory, "sessions.db"));
}

function saveReplica(database: SessionDatabase, options: { grantEpoch?: number } = {}): void {
    scopeShareReplicaSave(database, {
        createdAt: 1,
        grantEpoch: options.grantEpoch ?? 1,
        memberCount: 2,
        murmurPeerId: "peer-self",
        ownerPeerId: "peer-owner",
        scopeKind: "workspace",
        shareId: "share-1",
        shareMemberId: "member-1",
        state: "active",
        title: "scope-sharing",
        updatedAt: 1,
    });
}

function append(
    database: SessionDatabase,
    options: { grantEpoch?: number; sequence: number; sessionId?: string },
): boolean {
    return scopeShareReplicaAppend(database, {
        ...replicaEntry(options),
        grantEpoch: options.grantEpoch ?? 1,
        grantMemberId: "member-1",
        grantShareId: "share-1",
    });
}

function replicaEntry(options: { sequence: number; sessionId?: string }) {
    const sessionId = options.sessionId ?? "session-a";
    const projection: ScopeShareProjection = {
        payload: {
            agentKind: "primary",
            archived: false,
            createdAt: 1,
            modelLabel: "anthropic/opus-5",
            providerLabel: "claude",
            rootSessionId: sessionId,
            sessionId,
            status: "idle",
            updatedAt: 1,
        },
        sessionId,
        subject: "session_index",
        version: 1,
    };
    const entry = projectScopeShareEntry({
        createdAt: 2,
        projection,
        shareEventId: `event-${String(options.sequence)}`,
        shareId: "share-1",
        shareSequence: options.sequence,
    });
    return {
        canonicalJson: entry.canonicalJson,
        contentHash: entry.contentHash,
        createdAt: entry.createdAt,
        sequence: entry.shareSequence,
        shareEventId: entry.shareEventId,
        shareId: entry.shareId,
    };
}
