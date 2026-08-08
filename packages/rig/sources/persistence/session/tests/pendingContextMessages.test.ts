import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projects, sessions } from "../../database/schema.js";
import { queryPendingContextMessages } from "../queryPendingContextMessages.js";
import { querySessionTranscriptPage } from "../querySessionTranscriptPage.js";
import { sessionDrainPendingContextMessages } from "../sessionDrainPendingContextMessages.js";
import { sessionSavePendingContextMessage } from "../sessionSavePendingContextMessage.js";

describe("pending context messages", () => {
    it("stores visible anchors atomically and drains FIFO into model context", () => {
        const opened = createDatabase();
        const first = pending("note-1", 0);
        const second = pending("note-2", 1);

        opened.database.transaction((tx) => {
            sessionSavePendingContextMessage(tx, "session-1", first, 10);
            sessionSavePendingContextMessage(tx, "session-1", second, 11);
        });

        expect(queryPendingContextMessages(opened.database, "session-1")).toEqual([first, second]);
        expect(
            querySessionTranscriptPage(opened.database, "session-1", 10)?.messages,
        ).toMatchObject([
            { message: { id: "note-1" }, runId: "context:note-1" },
            { message: { id: "note-2" }, runId: "context:note-2" },
        ]);
        expect(sessionDrainPendingContextMessages(opened.database, "session-1")).toEqual([
            first,
            second,
        ]);
        expect(queryPendingContextMessages(opened.database, "session-1")).toEqual([]);
        expect(
            opened.database.all<{ messageId: string }>(sql`
                SELECT message_id AS messageId
                FROM session_context_messages
                WHERE session_id = 'session-1'
                ORDER BY position
            `),
        ).toEqual([{ messageId: "note-1" }, { messageId: "note-2" }]);
        opened.client.close();
    });

    it("keeps the queue intact when a surrounding actionable-boundary transaction fails", () => {
        const opened = createDatabase();
        const first = pending("note-1", 0);
        const second = pending("note-2", 1);
        opened.database.transaction((tx) => {
            sessionSavePendingContextMessage(tx, "session-1", first, 10);
            sessionSavePendingContextMessage(tx, "session-1", second, 11);
        });

        expect(() =>
            opened.database.transaction((tx) => {
                sessionDrainPendingContextMessages(tx, "session-1");
                throw new Error("actionable message could not be committed");
            }),
        ).toThrow("actionable message could not be committed");

        expect(queryPendingContextMessages(opened.database, "session-1")).toEqual([first, second]);
        expect(
            opened.database.all<{ count: number }>(sql`
                SELECT COUNT(*) AS count
                FROM session_context_messages
                WHERE session_id = 'session-1'
            `),
        ).toEqual([{ count: 0 }]);
        opened.client.close();
    });
});

function pending(id: string, position: number) {
    return {
        anchorRunId: `context:${id}`,
        createdAt: position + 1,
        message: {
            blocks: [{ text: id, type: "text" as const }],
            contextOnly: true as const,
            id,
            role: "user" as const,
        },
        position,
    };
}

function createDatabase() {
    const opened = openSessionDatabase(":memory:");
    migrateSessionDatabase(opened.database);
    opened.database
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id: "project-1",
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: "Workspace",
            nameKey: "workspace",
            nameSource: "folder",
            orderKey: "a0",
            path: "/workspace",
            presence: "present",
            storageKey: "workspace",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "unknown",
        })
        .run();
    opened.database
        .insert(sessions)
        .values({
            agentId: "agent-1",
            archived: false,
            createdAtMs: 1,
            cwd: "/workspace",
            depth: 0,
            durableSkillsJson: "[]",
            elapsedMs: 0,
            externalToolsJson: "[]",
            id: "session-1",
            interrupted: false,
            modelId: "model",
            ownerInstanceId: "alocalinstance00000000001",
            modelsJson: "[]",
            nextTaskId: 1,
            orderKey: "a0",
            permissionMode: "workspace_write",
            projectId: "project-1",
            providerId: "codex",
            rootSessionId: "session-1",
            secretIdsJson: "[]",
            sessionKind: "primary",
            status: "idle",
            tasksJson: "[]",
            titleStatus: "idle",
            toolsJson: "[]",
            totalTokens: 0,
            trackUnread: false,
            updatedAtMs: 1,
            workflowsEnabled: true,
            workflowsJson: "[]",
        })
        .run();
    return opened;
}
