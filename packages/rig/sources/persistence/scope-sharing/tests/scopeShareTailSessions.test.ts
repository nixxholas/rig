import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { ScopeShareProjection } from "../../../scope-sharing/projectScopeShareEntry.js";
import type { SessionDatabase } from "../../database/openSessionDatabase.js";
import { queryScopeShareOutbox } from "../queryScopeShareOutbox.js";
import { queryScopeShareSessionCursors } from "../queryScopeShareSessionCursors.js";
import { scopeShareCreate } from "../scopeShareCreate.js";
import { scopeShareTailSessions, type ScopeShareTailLimits } from "../scopeShareTailSessions.js";
import {
    createScopeShareFixture,
    insertSession,
    insertSessionEvents,
    WORKSPACE_ID,
} from "./createScopeShareFixture.js";

const directories: string[] = [];

const limits: ScopeShareTailLimits = {
    degradeAboveBytes: 64 * 1024 * 1024,
    degradeAboveCount: 100_000,
    passByteLimit: 256 * 1024,
    passEntryLimit: 100,
    sessionPageSize: 2,
};

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("scopeShareTailSessions", () => {
    it("publishes the scope facts once and again only when the scope changes", () => {
        const fixture = openFixture();
        try {
            createShare(fixture.database);

            const first = tail(fixture.database, { now: 5 });
            const second = tail(fixture.database, { now: 6 });

            expect(first.appended).toBe(1);
            expect(second.appended).toBe(0);
            const entry = projections(fixture.database)[0];
            expect(entry?.subject).toBe("scope");
            expect(entry?.subject === "scope" ? entry.payload : undefined).toMatchObject({
                folderName: "scope-sharing",
                name: "scope-sharing",
                scopeId: WORKSPACE_ID,
                scopeKind: "workspace",
                status: "ready",
            });
            // Only the folder's own name travels, never the path that leads to it.
            expect(JSON.stringify(entry)).not.toContain("/home/owner");
        } finally {
            fixture.close();
        }
    });

    it("never carries a session's excluded configuration into the log", () => {
        const fixture = openFixture();
        try {
            insertSession(fixture.database, { id: "session-a", title: "Deploy work" });
            insertSessionEvents(fixture.database, { count: 2, sessionId: "session-a" });
            createShare(fixture.database);

            tail(fixture.database, { now: 5 });

            // The design excludes all of these outright. Asserting on the whole log rather
            // than on the projection's shape is deliberate: a field added to the projection
            // later has to pass this too, and a leak is exactly the kind of change that
            // arrives by accident.
            const log = JSON.stringify(projections(fixture.database));
            expect(log).toContain("Deploy work");
            for (const excluded of [
                "registry.internal/private:1",
                "deploy-runbook",
                "internal-jira",
                "Never reveal the staging credentials.",
                "secret-deploy-key",
                "You are Rig, running against the production cluster.",
                "workspace_write",
                "/home/owner",
            ]) {
                expect(log).not.toContain(excluded);
            }
        } finally {
            fixture.close();
        }
    });

    it("gives every session a turn rather than draining the busiest one first", () => {
        const fixture = openFixture();
        try {
            insertSession(fixture.database, { id: "session-busy" });
            insertSession(fixture.database, { createdAt: 2, id: "session-quiet" });
            insertSessionEvents(fixture.database, { count: 12, sessionId: "session-busy" });
            insertSessionEvents(fixture.database, { count: 2, sessionId: "session-quiet" });
            createShare(fixture.database);

            tail(fixture.database, { now: 5 });

            const transcripts = projections(fixture.database).filter(
                (projection) => projection.subject === "session_event",
            );
            // A busy session takes `sessionPageSize` and no more, so the quiet one is
            // heard from in the same pass instead of waiting for the busy one to drain.
            expect(transcripts.map((projection) => subjectOf(projection))).toEqual([
                "session-busy",
                "session-quiet",
            ]);
        } finally {
            fixture.close();
        }
    });

    it("keeps a session cut off by the pass budget at the front of the queue", () => {
        const fixture = openFixture();
        try {
            insertSession(fixture.database, { id: "session-a" });
            insertSession(fixture.database, { createdAt: 2, id: "session-b" });
            insertSessionEvents(fixture.database, { count: 20, sessionId: "session-a" });
            insertSessionEvents(fixture.database, { count: 20, sessionId: "session-b" });
            createShare(fixture.database);
            const narrow: ScopeShareTailLimits = {
                ...limits,
                passEntryLimit: 2,
                sessionPageSize: 1,
            };

            // The scope facts and one session index fill the pass, so `session-b` never
            // gets its turn and must not lose its place because of it.
            const first = tail(fixture.database, { limits: narrow, now: 5 });
            const afterFirst = queueOf(fixture.database);
            tail(fixture.database, { limits: narrow, now: 6 });
            const afterSecond = queueOf(fixture.database);

            expect(first.pending).toBe(true);
            expect(afterFirst).toEqual(["session-b", "session-a"]);
            expect(afterSecond).toEqual(["session-b", "session-a"]);
            for (const now of [7, 8, 9, 10]) tail(fixture.database, { limits: narrow, now });
            const counts = new Map<string, number>();
            for (const projection of projections(fixture.database)) {
                const subject = subjectOf(projection);
                counts.set(subject, (counts.get(subject) ?? 0) + 1);
            }
            // Neither session is starved: after several bounded passes the two are
            // within one turn of each other, rather than one having taken everything.
            expect(
                Math.abs((counts.get("session-a") ?? 0) - (counts.get("session-b") ?? 0)),
            ).toBeLessThanOrEqual(narrow.sessionPageSize);
            expect(counts.get("session-b")).toBeGreaterThan(0);
        } finally {
            fixture.close();
        }
    });

    it("writes one session index entry per change and never repeats an unchanged one", () => {
        const fixture = openFixture();
        try {
            insertSession(fixture.database, { id: "session-a", title: "First title" });
            createShare(fixture.database);

            tail(fixture.database, { now: 5 });
            tail(fixture.database, { now: 6 });
            fixture.database.run(
                sql.raw(
                    "UPDATE sessions SET title = 'Second title', updated_at_ms = 50 WHERE id = 'session-a'",
                ),
            );
            tail(fixture.database, { now: 7 });

            const indexes = projections(fixture.database).filter(
                (projection) => projection.subject === "session_index",
            );
            expect(indexes).toHaveLength(2);
            expect(
                indexes.map((projection) =>
                    projection.subject === "session_index" ? projection.payload.title : undefined,
                ),
            ).toEqual(["First title", "Second title"]);
            expect(
                indexes[0]?.subject === "session_index" ? indexes[0].payload : undefined,
            ).toMatchObject({ modelLabel: "anthropic/opus-5", providerLabel: "claude" });
            // None of what the session was configured with belongs to a member.
            expect(JSON.stringify(indexes)).not.toContain("workspace_write");
        } finally {
            fixture.close();
        }
    });

    it("resumes across a restart with no gap and no duplicate", () => {
        const directory = mkdtempSync(join(tmpdir(), "scope-share-restart-"));
        directories.push(directory);
        const path = join(directory, "sessions.db");
        const before = createScopeShareFixture(path);
        insertSession(before.database, { id: "session-a" });
        insertSessionEvents(before.database, { count: 5, sessionId: "session-a" });
        createShare(before.database);
        tail(before.database, { now: 5 });
        const beforeRestart = sequencesOf(before.database);
        before.close();

        const after = createScopeShareFixture(path);
        try {
            for (const now of [6, 7, 8]) tail(after.database, { now });
            const sequences = sequencesOf(after.database);

            expect(sequences.slice(0, beforeRestart.length)).toEqual(beforeRestart);
            expect(sequences).toEqual(
                Array.from({ length: sequences.length }, (_, index) => index + 1),
            );
            const transcripts = projections(after.database).filter(
                (projection) => projection.subject === "session_event",
            );
            expect(transcripts).toHaveLength(5);
            expect(new Set(transcripts.map((projection) => JSON.stringify(projection))).size).toBe(
                5,
            );
        } finally {
            after.close();
        }
    });
});

function openFixture(): { close: () => void; database: SessionDatabase } {
    const directory = mkdtempSync(join(tmpdir(), "scope-share-tail-"));
    directories.push(directory);
    return createScopeShareFixture(join(directory, "sessions.db"));
}

function tail(database: SessionDatabase, options: { limits?: ScopeShareTailLimits; now: number }) {
    return scopeShareTailSessions(database, {
        limits: options.limits ?? limits,
        now: options.now,
        shareId: "share-1",
    });
}

function createShare(database: SessionDatabase): void {
    scopeShareCreate(database, {
        members: [
            { displayName: "Friend", murmurPeerId: "peer-friend", shareMemberId: "member-friend" },
        ],
        now: 1,
        ownerPeerId: "peer-owner",
        scopeId: WORKSPACE_ID,
        scopeKind: "workspace",
        shareId: "share-1",
    });
}

function projections(database: SessionDatabase): readonly ScopeShareProjection[] {
    return queryScopeShareOutbox(database, { limit: 1_000, shareId: "share-1" }).map(
        (entry) => JSON.parse(entry.canonicalJson) as ScopeShareProjection,
    );
}

function sequencesOf(database: SessionDatabase): readonly number[] {
    return queryScopeShareOutbox(database, { limit: 1_000, shareId: "share-1" }).map(
        (entry) => entry.sequence,
    );
}

function queueOf(database: SessionDatabase): readonly string[] {
    return queryScopeShareSessionCursors(database, "share-1").map((cursor) => cursor.sessionId);
}

function subjectOf(projection: ScopeShareProjection): string {
    return projection.subject === "scope" ? projection.payload.scopeId : projection.sessionId;
}
