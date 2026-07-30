import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projectAvatarAssets, projects, projectWorkspaces } from "../../database/schema.js";
import { inTx } from "../../inTx.js";
import { projectSetAvatar } from "../projectSetAvatar.js";
import { workspaceReserve } from "../workspaceReserve.js";

describe("project persistence", () => {
    it("rolls back the avatar asset and project reference together", () => {
        const opened = databaseWithProject();

        expect(() =>
            inTx(opened.database, (tx) => {
                projectSetAvatar(tx, {
                    asset: { byteLength: 3, hash: "a".repeat(64), height: 1, width: 1 },
                    now: 2,
                    projectId: "project-1",
                    source: "user",
                });
                throw new Error("fail after avatar");
            }),
        ).toThrow("fail after avatar");

        expect(opened.database.select().from(projectAvatarAssets).all()).toEqual([]);
        expect(
            opened.database
                .select({ avatarHash: projects.avatarHash })
                .from(projects)
                .where(eq(projects.id, "project-1"))
                .get(),
        ).toEqual({ avatarHash: null });
        opened.client.close();
    });

    it("rolls back a complete workspace reservation with its outer action", () => {
        const opened = databaseWithProject();

        expect(() =>
            inTx(opened.database, (tx) => {
                workspaceReserve(tx, {
                    baseCommit: "a".repeat(40),
                    baseRef: "main",
                    clientRequestId: "request-1",
                    gitCommonDir: "/workspace/.git",
                    id: "workspace-1",
                    name: "Feature",
                    now: 2,
                    pathForStorageKey: (key) => `/state/workspaces/project/${key}`,
                    projectId: "project-1",
                });
                throw new Error("fail after workspace");
            }),
        ).toThrow("fail after workspace");

        expect(opened.database.select().from(projectWorkspaces).all()).toEqual([]);
        opened.client.close();
    });
});

function databaseWithProject(): ReturnType<typeof openSessionDatabase> {
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
            worktreeSupport: "supported",
        })
        .run();
    return opened;
}
