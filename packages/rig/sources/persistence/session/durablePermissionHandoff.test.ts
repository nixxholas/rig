import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../database/openSessionDatabase.js";
import { externalToolCalls, projects, sessions } from "../database/schema.js";
import { durablePermissionHandoff } from "./durablePermissionHandoff.js";

describe("durablePermissionHandoff", () => {
    it("rolls back the external call when the permission input cannot be saved", () => {
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

        expect(() =>
            durablePermissionHandoff(
                opened.database,
                {
                    arguments: {},
                    batchId: "batch-1",
                    consumed: false,
                    createdAt: 1,
                    definition: {
                        description: "External operation",
                        name: "external_operation",
                        parameters: { type: "object" },
                    },
                    id: "external-call-1",
                    runId: "run-1",
                    sessionId: "session-1",
                    status: "pending",
                    toolCallId: "tool-call-1",
                    toolCallIndex: 0,
                },
                {
                    batchId: "batch-1",
                    consumed: false,
                    createdAt: 1,
                    kind: "permission",
                    permission: { action: "External operation", reason: "Test rollback" },
                    request: { questions: [], requestId: "permission-1" },
                    runId: "run-1",
                    sessionId: "missing-session",
                    status: "pending",
                    toolArguments: {},
                    toolCallId: "tool-call-1",
                    toolCallIndex: 0,
                    toolName: "external_operation",
                },
            ),
        ).toThrow();
        expect(
            opened.database
                .select()
                .from(externalToolCalls)
                .where(eq(externalToolCalls.id, "external-call-1"))
                .all(),
        ).toEqual([]);
        opened.client.close();
    });
});
