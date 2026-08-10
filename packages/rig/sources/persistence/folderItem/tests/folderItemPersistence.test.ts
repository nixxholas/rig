import { withDatabase } from "../../database/databaseContext.js";

import { createTestRootContext } from "../../../testing/createTestRootContext.js";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { folderArchive } from "../../folder/folderArchive.js";
import { folderCreate } from "../../folder/folderCreate.js";
import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { folderItems, projects } from "../../database/schema.js";
import { folderItemArchive } from "../folderItemArchive.js";
import { folderItemCreate } from "../folderItemCreate.js";
import { folderItemMove } from "../folderItemMove.js";
import { queryFolderItems } from "../queryFolderItems.js";
import {
    folderItemsWithActiveTargets,
    queryFolderItemTargetExists,
} from "../queryFolderItemTargetExists.js";

describe("folder item persistence", () => {
    it("allows duplicate links and orders each folder independently", async () => {
        const opened = await fixture();
        await createProject(opened.database, "project");
        await createFolder(opened.database, "left");
        await createFolder(opened.database, "right");

        await folderItemCreate(withDatabase(createTestRootContext(), opened.database), {
            folderId: "left",
            id: "item-a",
            now: 3,
            target: { kind: "project", projectId: "project" },
        });
        await folderItemCreate(withDatabase(createTestRootContext(), opened.database), {
            folderId: "left",
            id: "item-b",
            now: 4,
            target: { kind: "project", projectId: "project" },
        });
        await folderItemCreate(withDatabase(createTestRootContext(), opened.database), {
            folderId: "right",
            id: "item-c",
            now: 5,
            target: { kind: "project", projectId: "project" },
        });

        expect(
            (await queryFolderItems(withDatabase(createTestRootContext(), opened.database))).map(
                (item) => [item.id, item.folderId, item.orderKey],
            ),
        ).toEqual([
            ["item-a", "left", "a0"],
            ["item-b", "left", "a1"],
            ["item-c", "right", "a0"],
        ]);
        opened.client.close();
    });

    it("moves only the item and leaves project ordering and version unchanged", async () => {
        const opened = await fixture();
        await createProject(opened.database, "project");
        await createFolder(opened.database, "left");
        await createFolder(opened.database, "right");
        await folderItemCreate(withDatabase(createTestRootContext(), opened.database), {
            folderId: "left",
            id: "item",
            now: 2,
            target: { kind: "project", projectId: "project" },
        });
        const before = await opened.database
            .select({ orderKey: projects.orderKey, version: projects.version })
            .from(projects)
            .where(eq(projects.id, "project"))
            .get();

        expect(
            await folderItemMove(
                withDatabase(createTestRootContext(), opened.database),
                "item",
                "right",
                "a0",
                3,
                1,
            ),
        ).toEqual({
            outcome: "moved",
        });

        expect(
            (await queryFolderItems(withDatabase(createTestRootContext(), opened.database)))[0],
        ).toMatchObject({
            folderId: "right",
            orderKey: "a0",
            version: 2,
        });
        expect(
            await opened.database
                .select({ orderKey: projects.orderKey, version: projects.version })
                .from(projects)
                .where(eq(projects.id, "project"))
                .get(),
        ).toEqual(before);
        opened.client.close();
    });

    it("rejects archived targets and omits their live links from the active projection", async () => {
        const opened = await fixture();
        await createProject(opened.database, "project");
        await createFolder(opened.database, "folder");
        await folderItemCreate(withDatabase(createTestRootContext(), opened.database), {
            folderId: "folder",
            id: "item",
            now: 2,
            target: { kind: "project", projectId: "project" },
        });
        expect(
            await queryFolderItemTargetExists(
                withDatabase(createTestRootContext(), opened.database),
                {
                    kind: "project",
                    projectId: "project",
                },
            ),
        ).toBe(true);

        await opened.database
            .update(projects)
            .set({ archivedAtMs: 3 })
            .where(eq(projects.id, "project"))
            .run();

        expect(
            await queryFolderItemTargetExists(
                withDatabase(createTestRootContext(), opened.database),
                {
                    kind: "project",
                    projectId: "project",
                },
            ),
        ).toBe(false);
        expect(
            await folderItemsWithActiveTargets(
                withDatabase(createTestRootContext(), opened.database),
                await queryFolderItems(withDatabase(createTestRootContext(), opened.database)),
            ),
        ).toEqual([]);
        opened.client.close();
    });

    it("archives subtree items without archiving their targets", async () => {
        const opened = await fixture();
        await createProject(opened.database, "project");
        await createFolder(opened.database, "parent");
        await createFolder(opened.database, "child", "parent");
        await folderItemCreate(withDatabase(createTestRootContext(), opened.database), {
            folderId: "child",
            id: "item",
            now: 2,
            target: { kind: "project", projectId: "project" },
        });

        await folderArchive(withDatabase(createTestRootContext(), opened.database), "parent", 9);

        expect(
            await opened.database
                .select({ archivedAtMs: folderItems.archivedAtMs })
                .from(folderItems)
                .where(eq(folderItems.id, "item"))
                .get(),
        ).toEqual({ archivedAtMs: 9 });
        expect(
            await opened.database
                .select({ archivedAtMs: projects.archivedAtMs })
                .from(projects)
                .where(eq(projects.id, "project"))
                .get(),
        ).toEqual({ archivedAtMs: null });

        expect(
            await folderItemArchive(
                withDatabase(createTestRootContext(), opened.database),
                "item",
                10,
            ),
        ).toBe(0);
        opened.client.close();
    });

    it("enforces exactly one target in SQLite", async () => {
        const opened = await fixture();
        await createProject(opened.database, "project");
        await createFolder(opened.database, "folder");

        await expect(
            opened.database.run(
                sql.raw(`
                    INSERT INTO folder_items
                    (id, folder_id, order_key, version, created_at_ms, updated_at_ms)
                    VALUES ('none', 'folder', 'a0', 1, 1, 1)
                `),
            ),
        ).rejects.toThrow();
        await expect(
            opened.database.run(
                sql.raw(`
                    INSERT INTO folder_items
                    (id, folder_id, project_id, document_id, order_key, version, created_at_ms, updated_at_ms)
                    VALUES ('two', 'folder', 'project', 'missing', 'a0', 1, 1, 1)
                `),
            ),
        ).rejects.toThrow();
        opened.client.close();
    });
});

async function fixture() {
    const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
    await migrateSessionDatabase(withDatabase(createTestRootContext(), opened.database));
    return opened;
}

async function createFolder(
    database: Awaited<Awaited<ReturnType<typeof openSessionDatabase>>>["database"],
    id: string,
    parentId?: string,
): Promise<void> {
    await folderCreate(withDatabase(createTestRootContext(), database), {
        id,
        name: id,
        now: 1,
        ...(parentId === undefined ? {} : { parentId }),
        path: `/folders/${id}`,
    });
}

async function createProject(
    database: Awaited<Awaited<ReturnType<typeof openSessionDatabase>>>["database"],
    id: string,
): Promise<void> {
    await database
        .insert(projects)
        .values({
            archivedAtMs: null,
            createdAtMs: 1,
            defaultComputeGeneration: 0,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id,
            initializationAttempt: 0,
            initializationError: null,
            initializationStatus: "ready",
            kind: "regular",
            name: id,
            nameKey: id,
            nameSource: "user",
            orderKey: "project-order",
            path: `/projects/${id}`,
            presence: "present",
            storageKey: id,
            updatedAtMs: 1,
            userMutationVersion: 1,
            version: 7,
            worktreeSupport: "unknown",
            worktreeSupportReason: null,
        })
        .run();
}
