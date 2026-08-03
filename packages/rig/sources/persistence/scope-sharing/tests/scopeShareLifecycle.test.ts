import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionDatabase } from "../../database/openSessionDatabase.js";
import { queryScopeShare, queryScopeShareForScope } from "../queryScopeShare.js";
import { queryScopeShareEntryLog } from "../queryScopeShareEntryLog.js";
import { queryScopeShareOutbox } from "../queryScopeShareOutbox.js";
import { queryLiveScopeSharesInProject } from "../queryScopeShares.js";
import { scopeShareCreate } from "../scopeShareCreate.js";
import { scopeShareGrant } from "../scopeShareGrant.js";
import { scopeShareOutboxAcknowledge } from "../scopeShareOutboxAcknowledge.js";
import { scopeShareRevoke } from "../scopeShareRevoke.js";
import { scopeShareStop } from "../scopeShareStop.js";
import { scopeShareTailSessions, type ScopeShareTailLimits } from "../scopeShareTailSessions.js";
import {
    createScopeShareFixture,
    insertSession,
    insertSessionEvents,
    PROJECT_ID,
    WORKSPACE_ID,
} from "./createScopeShareFixture.js";

const directories: string[] = [];

const limits: ScopeShareTailLimits = {
    degradeAboveBytes: 64 * 1024 * 1024,
    degradeAboveCount: 100_000,
    passByteLimit: 256 * 1024,
    passEntryLimit: 100,
    sessionPageSize: 10,
};

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("scope share lifecycle", () => {
    it("allows only one live share of a scope", () => {
        const fixture = openFixture();
        try {
            createShare(fixture.database, { shareId: "share-1" });

            expect(() => createShare(fixture.database, { shareId: "share-2" })).toThrow(/UNIQUE/);
            // A stopped share leaves the scope free to be shared again.
            scopeShareStop(fixture.database, "share-1", 9);
            createShare(fixture.database, { shareId: "share-2" });

            expect(
                queryScopeShareForScope(fixture.database, {
                    scopeId: WORKSPACE_ID,
                    scopeKind: "workspace",
                })?.shareId,
            ).toBe("share-2");
        } finally {
            fixture.close();
        }
    });

    it("refuses to share a workspace whose project is already shared", () => {
        const fixture = openFixture();
        try {
            createShare(fixture.database, {
                scopeId: PROJECT_ID,
                scopeKind: "project",
                shareId: "share-project",
            });

            expect(() => createShare(fixture.database, { shareId: "share-workspace" })).toThrow(
                /already shared/,
            );
        } finally {
            fixture.close();
        }
    });

    it("orders a project's live shares with the project's own share last", () => {
        const fixture = openFixture();
        try {
            createShare(fixture.database, { shareId: "share-workspace" });
            createShare(fixture.database, {
                scopeId: PROJECT_ID,
                scopeKind: "project",
                shareId: "share-project",
            });

            // Archiving a project stops every workspace share beneath it before its own.
            expect(
                queryLiveScopeSharesInProject(fixture.database, PROJECT_ID).map(
                    (share) => share.shareId,
                ),
            ).toEqual(["share-workspace", "share-project"]);
        } finally {
            fixture.close();
        }
    });

    it("moves acknowledged outbox rows into the entry log in one step", () => {
        const fixture = openFixture();
        try {
            insertSession(fixture.database, { id: "session-a" });
            insertSessionEvents(fixture.database, { count: 3, sessionId: "session-a" });
            createShare(fixture.database, { shareId: "share-1" });
            scopeShareTailSessions(fixture.database, {
                includeTranscript: true,
                limits,
                now: 5,
                shareId: "share-1",
            });
            const published = queryScopeShareOutbox(fixture.database, {
                limit: 100,
                shareId: "share-1",
            });

            scopeShareOutboxAcknowledge(fixture.database, {
                now: 6,
                shareId: "share-1",
                throughSequence: published.length,
            });

            expect(
                queryScopeShareOutbox(fixture.database, { limit: 100, shareId: "share-1" }),
            ).toEqual([]);
            const log = queryScopeShareEntryLog(fixture.database, {
                afterSequence: 0,
                maxBytes: 1_000_000,
                maxItems: 100,
                shareId: "share-1",
            });
            expect(log.complete).toBe(true);
            expect(log.entries.map((entry) => entry.shareSequence)).toEqual(
                published.map((entry) => entry.sequence),
            );
            const share = queryScopeShare(fixture.database, "share-1");
            expect({ bytes: share?.outboxBytes, count: share?.outboxCount }).toEqual({
                bytes: 0,
                count: 0,
            });
        } finally {
            fixture.close();
        }
    });

    it("drops the entry log when the share stops", () => {
        const fixture = openFixture();
        try {
            insertSession(fixture.database, { id: "session-a" });
            createShare(fixture.database, { shareId: "share-1" });
            scopeShareTailSessions(fixture.database, {
                includeTranscript: true,
                limits,
                now: 5,
                shareId: "share-1",
            });
            scopeShareOutboxAcknowledge(fixture.database, {
                now: 6,
                shareId: "share-1",
                throughSequence: 100,
            });

            expect(scopeShareStop(fixture.database, "share-1", 7)).toBe(true);

            expect(
                queryScopeShareEntryLog(fixture.database, {
                    afterSequence: 0,
                    maxBytes: 1_000_000,
                    maxItems: 100,
                    shareId: "share-1",
                }).entries,
            ).toEqual([]);
            expect(queryScopeShare(fixture.database, "share-1")?.state).toBe("stopped");
        } finally {
            fixture.close();
        }
    });

    it("raises the grant epoch when a revoked friend is invited again", () => {
        const fixture = openFixture();
        try {
            createShare(fixture.database, { shareId: "share-1" });

            expect(
                scopeShareRevoke(fixture.database, {
                    now: 6,
                    shareId: "share-1",
                    shareMemberId: "member-share-1",
                }),
            ).toBe(true);
            const regranted = scopeShareGrant(fixture.database, {
                displayName: "Friend",
                murmurPeerId: "peer-friend",
                now: 7,
                shareId: "share-1",
                shareMemberId: "member-ignored",
            });

            // The same friend keeps their member id and receives a fresh epoch, which is
            // what tells a replica the entries it already holds no longer apply.
            expect(regranted.shareMemberId).toBe("member-share-1");
            expect(regranted.currentGrantEpoch).toBe(2);
        } finally {
            fixture.close();
        }
    });
});

function openFixture(): { close: () => void; database: SessionDatabase } {
    const directory = mkdtempSync(join(tmpdir(), "scope-share-lifecycle-"));
    directories.push(directory);
    return createScopeShareFixture(join(directory, "sessions.db"));
}

function createShare(
    database: SessionDatabase,
    options: { scopeId?: string; scopeKind?: "project" | "workspace"; shareId: string },
): void {
    scopeShareCreate(database, {
        members: [
            {
                displayName: "Friend",
                murmurPeerId: "peer-friend",
                shareMemberId: `member-${options.shareId}`,
            },
        ],
        now: 1,
        ownerPeerId: "peer-owner",
        scopeId: options.scopeId ?? WORKSPACE_ID,
        scopeKind: options.scopeKind ?? "workspace",
        shareId: options.shareId,
    });
}
