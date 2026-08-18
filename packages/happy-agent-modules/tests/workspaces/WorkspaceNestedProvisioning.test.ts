import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitModule } from "../../sources/git/index.js";
import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import {
    WorkspacesModule,
    workspaceMigrations,
    type CreateWorkspaceRequest,
    type Workspace,
} from "../../sources/workspaces/index.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    git,
    gitRunner,
} from "../git/helpers.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

afterEach(cleanupRoots);

describe("nested workspace provisioning", () => {
    it("creates a child worktree from its ready parent branch", async () => {
        const repository = await createRepository();
        await commitFile(repository, "project.txt", "project\n");
        const world = await createWorld("nested-worktree");
        try {
            const parentId = createId();
            const childId = createId();
            const project = await world.projects.create(world.database.context, {
                id: "project-a",
                repositoryRef: world.git.normalizeProjectCwd(repository),
                name: "Project",
            });
            const readyRoot = await readyProject(world, project.id);
            if (readyRoot.worktreeSupport !== "supported") {
                throw new Error(
                    readyRoot.worktreeUnsupportedReason ?? "Worktrees are unsupported.",
                );
            }
            expect(readyRoot.worktreeSupport).toBe("supported");
            const parent = await createReadyWorkspace(world, project.id, {
                id: parentId,
                name: "Parent",
            });
            const parentCommit = await commitFile(parent.path, "from-parent.txt", "parent\n");

            const child = await world.workspaces.createWorkspace(
                world.database.context,
                project.id,
                {
                    id: childId,
                    name: "Child",
                    parentId: parent.id,
                } as CreateWorkspaceRequest,
            );

            expect(child).toMatchObject({
                id: childId,
                parentId: parent.id,
                baseRef: parent.branch,
                status: "initializing",
            });
            const ready = await waitForWorkspace(world, childId, "ready");
            expect(await readFile(join(ready.path, "from-parent.txt"), "utf8")).toBe("parent\n");
            expect(await git(ready.path, ["rev-parse", "HEAD"])).toBe(parentCommit);
        } finally {
            await world.close();
        }
    });

    it("copies a child directory from its ready parent folder", async () => {
        const repository = join(await createRoot("nested-directory-project-"), "project");
        await mkdir(repository);
        await writeFile(join(repository, "project.txt"), "project\n", "utf8");
        const world = await createWorld("nested-directory");
        try {
            const parentId = createId();
            const childId = createId();
            const project = await world.projects.create(world.database.context, {
                id: "project-a",
                repositoryRef: world.git.normalizeProjectCwd(repository),
                name: "Project",
            });
            await readyProject(world, project.id);
            const parent = await createReadyWorkspace(world, project.id, {
                id: parentId,
                name: "Parent",
            });
            await writeFile(join(parent.path, "from-parent.txt"), "parent\n", "utf8");

            await world.workspaces.createWorkspace(world.database.context, project.id, {
                id: childId,
                name: "Child",
                parentId: parent.id,
            } as CreateWorkspaceRequest);

            const ready = await waitForWorkspace(world, childId, "ready");
            expect(ready.kind).toBe("directory");
            expect(await readFile(join(ready.path, "from-parent.txt"), "utf8")).toBe("parent\n");
        } finally {
            await world.close();
        }
    });

    it("rejects unavailable and cross-project parents without leaving reservations", async () => {
        const root = await createRoot("nested-parent-boundaries-");
        const firstFolder = join(root, "first");
        const secondFolder = join(root, "second");
        await mkdir(firstFolder);
        await mkdir(secondFolder);
        const world = await createWorld("nested-parent-boundaries");
        try {
            const unavailableChildId = createId();
            const crossProjectChildId = createId();
            const first = await world.projects.create(world.database.context, {
                id: "project-a",
                repositoryRef: firstFolder,
                name: "First",
            });
            const second = await world.projects.create(world.database.context, {
                id: "project-b",
                repositoryRef: secondFolder,
                name: "Second",
            });
            await readyProject(world, first.id);
            await readyProject(world, second.id);
            const initializing = (
                await world.workspaces.reserve(world.database.context, {
                    id: "initializing-parent",
                    projectRef: "project-a",
                    name: "Initializing",
                    kind: "directory",
                })
            ).workspace;

            await expect(
                world.workspaces.createWorkspace(world.database.context, "project-a", {
                    id: unavailableChildId,
                    name: "Child",
                    parentId: initializing.id,
                } as CreateWorkspaceRequest),
            ).rejects.toThrow(/parent.*ready|parent.*available/iu);
            await expect(
                world.workspaces.createWorkspace(world.database.context, "project-b", {
                    id: crossProjectChildId,
                    name: "Child",
                    parentId: initializing.id,
                } as CreateWorkspaceRequest),
            ).rejects.toThrow(/same project/iu);
            expect(await world.workspaces.get(world.database.context, unavailableChildId)).toBe(
                undefined,
            );
            expect(await world.workspaces.get(world.database.context, crossProjectChildId)).toBe(
                undefined,
            );
        } finally {
            await world.close();
        }
    });

    it("keeps a parent active until its active children are archived", async () => {
        const world = await createWorld("nested-archive-boundary");
        try {
            const parent = await reserveReadyDirectory(world, "parent-workspace", "project-a");
            const child = await reserveReadyDirectory(
                world,
                "child-workspace",
                "project-a",
                parent.id,
            );

            await expect(
                world.workspaces.beginArchive(world.database.context, parent.id),
            ).rejects.toThrow(/active child|nested workspace/iu);
            expect(await world.workspaces.get(world.database.context, parent.id)).toMatchObject({
                status: "ready",
            });

            await world.workspaces.beginArchive(world.database.context, child.id);
            await expect(
                world.workspaces.beginArchive(world.database.context, parent.id),
            ).resolves.toMatchObject({ status: "archiving" });
        } finally {
            await world.close();
        }
    });

    it("archives an entire project from deepest workspace to root", async () => {
        const root = await createRoot("nested-project-archive-");
        const folder = join(root, "project");
        await mkdir(folder);
        const world = await createWorld("nested-project-archive");
        try {
            const project = await world.projects.create(world.database.context, {
                id: "project-a",
                repositoryRef: world.git.normalizeProjectCwd(folder),
                name: "Project",
            });
            const parent = await reserveReadyDirectory(world, "parent-workspace", project.id);
            const child = await reserveReadyDirectory(
                world,
                "child-workspace",
                project.id,
                parent.id,
            );

            await expect(
                world.projects.archive(world.database.context, project.id),
            ).resolves.toMatchObject({ status: "archived" });
            expect(await world.workspaces.get(world.database.context, child.id)).toMatchObject({
                status: expect.stringMatching(/^archiv(?:ing|ed)$/u),
            });
            expect(await world.workspaces.get(world.database.context, parent.id)).toMatchObject({
                status: expect.stringMatching(/^archiv(?:ing|ed)$/u),
            });
        } finally {
            await world.close();
        }
    });

    it("settles a reserved child as failed when its parent becomes unavailable", async () => {
        const root = await createRoot("nested-parent-failure-project-");
        const folder = join(root, "project");
        await mkdir(folder);
        const world = await createWorld("nested-parent-failure");
        try {
            const project = await world.projects.create(world.database.context, {
                id: "project-a",
                repositoryRef: world.git.normalizeProjectCwd(folder),
                name: "Project",
            });
            await readyProject(world, project.id);
            const parent = await reserveReadyDirectory(world, "parent-workspace", "project-a");
            const child = (
                await world.workspaces.reserve(world.database.context, {
                    id: "child-workspace",
                    projectRef: "project-a",
                    parentId: parent.id,
                    name: "Child",
                    kind: "directory",
                })
            ).workspace;
            await world.workspaces.markFailed(world.database.context, {
                workspaceId: parent.id,
                error: "The parent folder disappeared.",
            });

            await world.workspaces.reconcileInitializingWorkspaces(world.database.context);

            expect(await world.workspaces.get(world.database.context, child.id)).toMatchObject({
                status: "failed",
                initializationError: expect.stringMatching(/parent.*ready|parent.*available/iu),
            });
        } finally {
            await world.close();
        }
    });
});

async function createWorld(name: string) {
    const root = await createRoot(`happy-${name}-`);
    const config = await testConfigRootedAt(root);
    const gitModule = GitModule.withRunner(gitRunner);
    const projects = new ProjectsModule(config, gitModule);
    const workspaces = new WorkspacesModule(config, projects, gitModule);
    const database = moduleDatabase(
        [...projectMigrations, ...workspaceMigrations],
        `${name}-database`,
    );
    await database.ready;
    return {
        config,
        git: gitModule,
        projects,
        workspaces,
        database,
        close: async () => {
            await workspaces.close(database.context);
            await projects.close(database.context);
            database.close();
        },
    };
}

async function createReadyWorkspace(
    world: Awaited<ReturnType<typeof createWorld>>,
    projectId: string,
    request: CreateWorkspaceRequest,
): Promise<Workspace> {
    const workspace = await world.workspaces.createWorkspace(
        world.database.context,
        projectId,
        request,
    );
    if (workspace === undefined) throw new Error("The project was not found.");
    return await waitForWorkspace(world, workspace.id, "ready");
}

async function readyProject(
    world: Awaited<ReturnType<typeof createWorld>>,
    projectId: string,
): Promise<Awaited<ReturnType<typeof world.projects.markInitializationReady>>> {
    await world.projects.probe(world.database.context, projectId);
    return await world.projects.markInitializationReady(world.database.context, projectId);
}

async function waitForWorkspace(
    world: Awaited<ReturnType<typeof createWorld>>,
    workspaceId: string,
    status: Workspace["status"],
): Promise<Workspace> {
    let workspace: Workspace | undefined;
    await vi.waitFor(
        async () => {
            workspace = await world.workspaces.get(world.database.context, workspaceId);
            if (workspace?.status === "failed" && status !== "failed") {
                throw new Error(
                    workspace.initializationError ?? "Workspace initialization failed.",
                );
            }
            expect(workspace?.status).toBe(status);
        },
        { timeout: 15_000 },
    );
    if (workspace === undefined) throw new Error("The workspace was not found.");
    return workspace;
}

async function reserveReadyDirectory(
    world: Awaited<ReturnType<typeof createWorld>>,
    id: string,
    projectRef: string,
    parentId?: string,
): Promise<Workspace> {
    const reserved = await world.workspaces.reserve(world.database.context, {
        id,
        projectRef,
        ...(parentId === undefined ? {} : { parentId }),
        name: id,
        kind: "directory",
    });
    return await world.workspaces.markReady(world.database.context, {
        workspaceId: reserved.workspace.id,
    });
}
