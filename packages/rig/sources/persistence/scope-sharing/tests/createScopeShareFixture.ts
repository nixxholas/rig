import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase, type SessionDatabase } from "../../database/openSessionDatabase.js";
import { projects, projectWorkspaces, sessionEvents, sessions } from "../../database/schema.js";

export const PROJECT_ID = "project-1";
export const WORKSPACE_ID = "workspace-1";

/**
 * A project with one workspace and no sessions.
 *
 * Each test adds the sessions it wants, because what a scope share does depends
 * entirely on how many sessions it is tailing and how busy each one is.
 */
export function createScopeShareFixture(path: string): {
    close: () => void;
    database: SessionDatabase;
} {
    const opened = openSessionDatabase(path);
    migrateSessionDatabase(opened.database);
    // Reopening the same file is how a restart is tested, so seeding is idempotent.
    opened.database
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id: PROJECT_ID,
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: "Rig",
            nameKey: "rig",
            nameSource: "folder",
            orderKey: "a0",
            path: "/home/owner/Developer/rig",
            presence: "present",
            storageKey: "rig",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "supported",
        })
        .onConflictDoNothing()
        .run();
    opened.database
        .insert(projectWorkspaces)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitCommonDir: "/home/owner/Developer/rig/.git",
            gitDetached: false,
            id: WORKSPACE_ID,
            kind: "worktree",
            name: "scope-sharing",
            nameKey: "scope-sharing",
            orderKey: "a0",
            path: "/home/owner/Happy/Workspaces/rig/scope-sharing",
            presence: "present",
            projectId: PROJECT_ID,
            status: "ready",
            storageKey: "scope-sharing",
            updatedAtMs: 1,
            version: 1,
        })
        .onConflictDoNothing()
        .run();
    return { close: () => opened.client.close(), database: opened.database };
}

export function insertSession(
    database: SessionDatabase,
    input: { createdAt?: number; id: string; title?: string; workspaceId?: string | null },
): void {
    const createdAt = input.createdAt ?? 1;
    database
        .insert(sessions)
        .values({
            agentId: `agent-${input.id}`,
            archived: false,
            createdAtMs: createdAt,
            cwd: "/home/owner/Happy/Workspaces/rig/scope-sharing",
            depth: 0,
            durableSkillsJson: "[]",
            elapsedMs: 0,
            externalToolsJson: "[]",
            id: input.id,
            interrupted: false,
            modelId: "anthropic/opus-5",
            modelsJson: "[]",
            nextTaskId: 1,
            orderKey: "a0",
            permissionMode: "workspace_write",
            projectId: PROJECT_ID,
            providerId: "claude",
            rootSessionId: input.id,
            secretIdsJson: "[]",
            sessionKind: "primary",
            status: "idle",
            tasksJson: "[]",
            title: input.title ?? null,
            titleStatus: "idle",
            toolsJson: "[]",
            totalTokens: 0,
            trackUnread: false,
            updatedAtMs: createdAt,
            workflowsEnabled: true,
            workflowsJson: "[]",
            workspaceId: input.workspaceId === undefined ? WORKSPACE_ID : input.workspaceId,
        })
        .run();
}

/** Append visible transcript events, which is what makes a session "busy". */
export function insertSessionEvents(
    database: SessionDatabase,
    input: { count: number; sessionId: string },
): void {
    for (let index = 0; index < input.count; index += 1) {
        database
            .insert(sessionEvents)
            .values({
                createdAtMs: 10 + index,
                dataJson: JSON.stringify({ notice: `${input.sessionId}-${String(index)}` }),
                eventId: `${input.sessionId}-event-${String(index)}`,
                sessionId: input.sessionId,
                type: "system_notice",
            })
            .run();
    }
}
