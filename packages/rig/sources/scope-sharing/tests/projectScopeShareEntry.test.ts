import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { shareContentHash } from "../../sharing/canonicalShareJson.js";
import {
    projectScopeShareEntry,
    scopeShareProjectionSchema,
    scopeShareProjectionSubject,
    type ScopeShareProjection,
} from "../projectScopeShareEntry.js";

const scope: ScopeShareProjection = {
    payload: {
        archived: false,
        createdAt: 1,
        folderName: "scope-sharing",
        gitAhead: 2,
        gitBehind: 0,
        gitBranch: "worktree/scope-sharing",
        gitDetached: false,
        name: "scope-sharing",
        scopeId: "workspace-1",
        scopeKind: "workspace",
        status: "ready",
        updatedAt: 4,
    },
    subject: "scope",
    version: 1,
};

const sessionIndex: ScopeShareProjection = {
    payload: {
        agentKind: "primary",
        archived: false,
        createdAt: 1,
        modelLabel: "Opus 5",
        providerLabel: "Claude",
        rootSessionId: "session-a",
        sessionId: "session-a",
        status: "idle",
        updatedAt: 2,
    },
    sessionId: "session-a",
    subject: "session_index",
    version: 1,
};

describe("projectScopeShareEntry", () => {
    it("hashes the canonical form it publishes", () => {
        const entry = projectScopeShareEntry({
            createdAt: 5,
            projection: scope,
            shareEventId: "event-1",
            shareId: "wsp_abc",
            shareSequence: 1,
        });

        expect(entry.contentHash).toBe(shareContentHash(entry.canonicalJson));
        expect(JSON.parse(entry.canonicalJson)).toEqual(scope);
    });

    it("names the subject each projection belongs to", () => {
        expect(scopeShareProjectionSubject(scope)).toEqual({
            subjectId: "workspace-1",
            subjectKind: "scope",
        });
        expect(scopeShareProjectionSubject(sessionIndex)).toEqual({
            subjectId: "session-a",
            subjectKind: "session_index",
        });
    });

    it("carries a transcript entry in the session-share projection unchanged", () => {
        const transcript: ScopeShareProjection = {
            payload: { kind: "event", payload: { type: "system_notice" }, version: 2 },
            sessionId: "session-a",
            subject: "session_event",
            version: 1,
        };

        expect(Value.Check(scopeShareProjectionSchema, transcript)).toBe(true);
        expect(scopeShareProjectionSubject(transcript)).toEqual({
            subjectId: "session-a",
            subjectKind: "session_event",
        });
    });

    it("refuses anything the scope deliberately does not replicate", () => {
        // The schemas are exact, so a field that was never meant to travel cannot be
        // added to a payload by accident somewhere upstream.
        for (const excluded of ["path", "cwd", "dockerJson", "instructions", "permissionMode"]) {
            expect(
                Value.Check(scopeShareProjectionSchema, {
                    ...scope,
                    payload: { ...scope.payload, [excluded]: "value" },
                }),
            ).toBe(false);
        }
    });
});
