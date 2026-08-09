import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projects, projectWorkspaces, sessions } from "../../database/schema.js";
import { folderArchive } from "../folderArchive.js";
import { folderCreate } from "../folderCreate.js";
import { folderMove } from "../folderMove.js";
import { folderUpdate } from "../folderUpdate.js";
import { queryFolder } from "../queryFolder.js";
import { queryFolders } from "../queryFolders.js";
import { sessionMoveScope } from "../../session/sessionMoveScope.js";

describe("folder persistence", () => {
    it("creates folders at the root and inside a parent", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        folderCreate(opened.database, {
            id: "videos",
            name: "Videos",
            now: 2,
            parentId: "media",
            path: "/folders/videos",
        });

        expect(queryFolder(opened.database, "media")).toEqual({
            createdAt: 1,
            id: "media",
            name: "Media",
            orderKey: "a0",
            path: "/folders/media",
            updatedAt: 1,
            version: 1,
        });
        expect(queryFolder(opened.database, "videos")?.parentId).toBe("media");
        expect(queryFolders(opened.database).map((folder) => folder.id)).toEqual([
            "media",
            "videos",
        ]);
        opened.client.close();
    });

    it("gives every new folder the last order key among its shared direct children", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, { id: "a", name: "A", now: 1, path: "/folders/a" });
        folderCreate(opened.database, { id: "b", name: "B", now: 1, path: "/folders/b" });
        folderCreate(opened.database, {
            id: "a1",
            name: "A1",
            now: 1,
            parentId: "a",
            path: "/folders/a1",
        });

        const keys = new Map(
            queryFolders(opened.database).map((folder) => [folder.id, folder.orderKey]),
        );
        expect(keys.get("a")).toBe("a0");
        expect(keys.get("b")).toBe("a1");
        expect(keys.get("a1")).toBe("a0");
        expect(queryFolders(opened.database).map((folder) => folder.id)).toEqual(["a", "a1", "b"]);
        opened.client.close();
    });

    it("clears an optional field with null and leaves absent fields alone", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            description: "Video work",
            icon: "🎬",
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });

        expect(folderUpdate(opened.database, "media", { description: null }, 2)).toBe(1);

        expect(queryFolder(opened.database, "media")).toMatchObject({
            icon: "🎬",
            name: "Media",
            updatedAt: 2,
            version: 2,
        });
        expect(queryFolder(opened.database, "media")?.description).toBeUndefined();
        opened.client.close();
    });

    it("refuses a stale update and accepts the current version", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });

        expect(folderUpdate(opened.database, "media", { name: "Films" }, 2, 7)).toBe(0);
        expect(folderUpdate(opened.database, "media", { name: "Films" }, 2, 1)).toBe(1);
        expect(queryFolder(opened.database, "media")?.name).toBe("Films");
        opened.client.close();
    });

    it("moves a folder between parents without touching its storage directory", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        folderCreate(opened.database, {
            id: "notes",
            name: "Notes",
            now: 1,
            path: "/folders/notes",
        });
        folderCreate(opened.database, {
            id: "videos",
            name: "Videos",
            now: 1,
            parentId: "media",
            path: "/folders/videos",
        });

        expect(folderMove(opened.database, "videos", "notes", "a5", 3)).toEqual({
            outcome: "moved",
        });

        expect(queryFolder(opened.database, "videos")).toMatchObject({
            orderKey: "a5",
            parentId: "notes",
            path: "/folders/videos",
            version: 2,
        });
        opened.client.close();
    });

    it("refuses a move directly through persistence that would create a cycle", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        folderCreate(opened.database, {
            id: "videos",
            name: "Videos",
            now: 1,
            parentId: "media",
            path: "/folders/videos",
        });

        expect(folderMove(opened.database, "media", "videos", "a0", 2)).toEqual({
            outcome: "cycle",
        });
        expect(queryFolder(opened.database, "media")?.parentId).toBeUndefined();
        expect(queryFolder(opened.database, "videos")?.parentId).toBe("media");
        opened.client.close();
    });

    it("refuses archived or missing parents through persistence", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "archive",
            name: "Archive",
            now: 1,
            path: "/folders/archive",
        });
        folderArchive(opened.database, "archive", 2);

        expect(
            folderCreate(opened.database, {
                id: "child",
                name: "Child",
                now: 3,
                parentId: "archive",
                path: "/folders/child",
            }),
        ).toEqual({ outcome: "parent_archived" });
        expect(folderMove(opened.database, "archive", "missing", "a0", 3)).toEqual({
            outcome: "parent_not_found",
        });
        opened.client.close();
    });

    it("archives a folder together with everything nested under it", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        folderCreate(opened.database, {
            id: "videos",
            name: "Videos",
            now: 1,
            parentId: "media",
            path: "/folders/videos",
        });
        folderCreate(opened.database, {
            id: "cuts",
            name: "Cuts",
            now: 1,
            parentId: "videos",
            path: "/folders/cuts",
        });
        folderCreate(opened.database, {
            id: "notes",
            name: "Notes",
            now: 1,
            path: "/folders/notes",
        });

        expect(folderArchive(opened.database, "media", 9)).toEqual({
            folders: 3,
            sessionIds: [],
        });

        expect(
            queryFolders(opened.database).map((folder) => [folder.id, folder.archivedAt]),
        ).toEqual([
            ["media", 9],
            ["videos", 9],
            ["cuts", 9],
            ["notes", undefined],
        ]);
        opened.client.close();
    });

    it("archives folder chats without turning them into workspace-archived sessions", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        insertSession(opened.database, "session-1");
        sessionMoveScope(opened.database, {
            cwd: "/folders/media",
            now: 2,
            scope: { folderId: "media", kind: "folder" },
            sessionId: "session-1",
        });

        folderArchive(opened.database, "media", 3);

        expect(
            opened.database
                .select({ archived: sessions.archived, status: sessions.status })
                .from(sessions)
                .where(eq(sessions.id, "session-1"))
                .get(),
        ).toEqual({ archived: true, status: "idle" });
        opened.client.close();
    });

    it("reports already hidden folder chats so their retained runtimes are still retired", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        insertSession(opened.database, "session-1");
        sessionMoveScope(opened.database, {
            cwd: "/folders/media",
            now: 2,
            scope: { folderId: "media", kind: "folder" },
            sessionId: "session-1",
        });
        opened.database
            .update(sessions)
            .set({ archived: true })
            .where(eq(sessions.id, "session-1"))
            .run();

        expect(folderArchive(opened.database, "media", 3).sessionIds).toEqual(["session-1"]);
        opened.client.close();
    });

    it("keeps the moment an already archived folder was put away", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        folderCreate(opened.database, {
            id: "videos",
            name: "Videos",
            now: 1,
            parentId: "media",
            path: "/folders/videos",
        });

        expect(folderArchive(opened.database, "videos", 4)).toEqual({
            folders: 1,
            sessionIds: [],
        });
        expect(folderArchive(opened.database, "media", 9)).toEqual({
            folders: 1,
            sessionIds: [],
        });

        expect(queryFolder(opened.database, "videos")?.archivedAt).toBe(4);
        expect(queryFolder(opened.database, "media")?.archivedAt).toBe(9);
        opened.client.close();
    });

    it("files a chat into a folder and clears it back to Unsorted", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "media",
            name: "Media",
            now: 1,
            path: "/folders/media",
        });
        insertSession(opened.database, "session-1");

        expect(
            sessionMoveScope(opened.database, {
                cwd: "/folders/media",
                now: 5,
                scope: { folderId: "media", kind: "folder" },
                sessionId: "session-1",
            }).scope,
        ).toEqual({ folderId: "media", kind: "folder" });
        expect(sessionFolderId(opened.database, "session-1")).toBe("media");

        expect(
            sessionMoveScope(opened.database, {
                cwd: "/folders/unsorted/session-1",
                now: 6,
                scope: { kind: "unsorted" },
                sessionId: "session-1",
            }).scope,
        ).toEqual({ kind: "unsorted" });
        expect(sessionFolderId(opened.database, "session-1")).toBeNull();
        opened.client.close();
    });

    it("refuses inactive folders and mismatched workspace ownership at the persistence boundary", () => {
        const opened = openFolderDatabase();
        folderCreate(opened.database, {
            id: "archive",
            name: "Archive",
            now: 1,
            path: "/folders/archive",
        });
        folderArchive(opened.database, "archive", 2);
        opened.database
            .insert(projects)
            .values({
                createdAtMs: 1,
                gitAhead: 0,
                gitBehind: 0,
                gitDetached: false,
                id: "project-2",
                initializationAttempt: 0,
                initializationStatus: "ready",
                kind: "regular",
                name: "Other project",
                nameKey: "other-project",
                nameSource: "folder",
                orderKey: "a1",
                path: "/other-workspace",
                presence: "present",
                storageKey: "other-project",
                updatedAtMs: 1,
                version: 1,
                worktreeSupport: "unknown",
            })
            .run();
        opened.database
            .insert(projectWorkspaces)
            .values({
                branch: "feature",
                createdAtMs: 1,
                gitAhead: 0,
                gitBehind: 0,
                gitCommonDir: "/workspace/.git",
                gitDetached: false,
                id: "workspace-1",
                kind: "managed",
                name: "Feature",
                nameConfigured: true,
                nameKey: "feature",
                orderKey: "a0",
                path: "/workspace/feature",
                presence: "present",
                projectId: "project-1",
                status: "ready",
                storageKey: "feature",
                updatedAtMs: 1,
                version: 1,
            })
            .run();
        insertSession(opened.database, "session-1");

        expect(() =>
            sessionMoveScope(opened.database, {
                cwd: "/folders/archive",
                now: 3,
                scope: { folderId: "archive", kind: "folder" },
                sessionId: "session-1",
            }),
        ).toThrow("active folder");
        expect(() =>
            sessionMoveScope(opened.database, {
                cwd: "/workspace/feature",
                now: 3,
                scope: {
                    kind: "workspace",
                    projectId: "project-2",
                    workspaceId: "workspace-1",
                },
                sessionId: "session-1",
            }),
        ).toThrow("does not belong");
        opened.client.close();
    });
});

function openFolderDatabase(): ReturnType<typeof openSessionDatabase> {
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
            name: "Project",
            nameKey: "project",
            nameSource: "folder",
            orderKey: "a0",
            path: "/workspace",
            presence: "present",
            storageKey: "project",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "unknown",
        })
        .run();
    return opened;
}

function insertSession(
    database: ReturnType<typeof openSessionDatabase>["database"],
    sessionId: string,
): void {
    database
        .insert(sessions)
        .values({
            agentId: `agent-${sessionId}`,
            archived: false,
            createdAtMs: 1,
            cwd: "/workspace",
            depth: 0,
            durableSkillsJson: "[]",
            elapsedMs: 0,
            externalToolsJson: "[]",
            id: sessionId,
            interrupted: false,
            modelId: "model",
            ownerInstanceId: "alocalinstance00000000001",
            modelsJson: "[]",
            nextTaskId: 1,
            orderKey: "a0",
            permissionMode: "workspace_write",
            projectId: "project-1",
            providerId: "codex",
            rootSessionId: sessionId,
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
}

function sessionFolderId(
    database: ReturnType<typeof openSessionDatabase>["database"],
    sessionId: string,
): string | null | undefined {
    return database
        .select({ folderId: sessions.folderId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get()?.folderId;
}
