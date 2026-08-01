import { describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projects, sessions } from "../../database/schema.js";
import type { DurableUserInputCall } from "../../../user-input/index.js";
import { durableUserInputPrune } from "../durableUserInputPrune.js";
import { durableUserInputSave } from "../durableUserInputSave.js";
import { queryDurableUserInputs } from "../queryDurableUserInputs.js";
import type { TX } from "../../Transaction.js";

function createDatabase(): TX {
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
    return opened.database;
}

function createQuestion(overrides: Partial<DurableUserInputCall>): DurableUserInputCall {
    return {
        batchId: "batch-1",
        consumed: false,
        createdAt: 10,
        kind: "question",
        request: {
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [{ description: "Use SQLite.", label: "SQLite" }],
                    question: "Which database should be used?",
                },
            ],
            requestId: "request-1",
        },
        runId: "run-1",
        sessionId: "session-1",
        status: "pending",
        toolArguments: {},
        toolCallId: "call-1",
        toolCallIndex: 0,
        toolName: "request_user_input",
        ...overrides,
    };
}

describe("detached questions in storage", () => {
    it("remembers that presence released the run, so a restart can still deliver the answer", () => {
        const tx = createDatabase();
        durableUserInputSave(tx, createQuestion({ consumed: true, detachedAt: 42 }));

        const [reloaded] = queryDurableUserInputs(tx, "session-1");

        expect(reloaded?.detachedAt).toBe(42);
        expect(reloaded?.status).toBe("pending");
    });

    it("keeps a detached question the user has not answered yet while pruning answered ones", () => {
        const tx = createDatabase();
        durableUserInputSave(tx, createQuestion({ consumed: true, detachedAt: 42 }));
        durableUserInputSave(
            tx,
            createQuestion({
                consumed: true,
                createdAt: 20,
                request: { questions: [], requestId: "request-2" },
                resolvedAt: 30,
                response: { answers: { database: ["SQLite"] } },
                status: "completed",
                toolCallId: "call-2",
                toolCallIndex: 1,
            }),
        );

        durableUserInputPrune(tx, "session-1", 0);

        expect(
            queryDurableUserInputs(tx, "session-1").map((call) => call.request.requestId),
        ).toEqual(["request-1"]);
    });
});
