import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Workspace } from "@slopus/happy-agent-modules";

import {
    createGitRepository,
    git,
    pausableGit,
    projectTestHarness,
    waitFor,
    type ProjectCatalogs,
    type ProjectTestHarness,
} from "./support.js";

const open: ProjectTestHarness[] = [];

async function harness(
    name: string,
    overrides: Parameters<typeof projectTestHarness>[1] = {},
): Promise<ProjectTestHarness> {
    const created = await projectTestHarness(name, overrides);
    open.push(created);
    return created;
}

afterEach(async () => {
    await Promise.all(open.splice(0).map((created) => created.dispose()));
});

/** A workspace, but only when it is the named project's — what a route asks the catalog for. */
async function ownedWorkspace(
    test: ProjectTestHarness,
    catalogs: ProjectCatalogs,
    projectId: string,
    workspaceId: string,
): Promise<Workspace | undefined> {
    const workspace = await catalogs.workspaces.get(test.ctx, workspaceId);
    return workspace?.projectRef === projectId ? workspace : undefined;
}

/** Imports a repository and waits until the project has finished being set up. */
async function readyProject(
    test: ProjectTestHarness,
    folder = "acme-api",
): Promise<{ id: string; path: string }> {
    const path = await createGitRepository(join(test.root, folder));
    const { project } = await test.workspaces.resolvePath(test.ctx, path);
    await waitFor(async () => {
        const current = await test.projects.get(test.ctx, project.id);
        return current?.initializationStatus === "ready" ? current : undefined;
    }, `project ${folder} to finish being set up`);
    return { id: project.id, path };
}

/** Waits for a workspace to reach `ready`, and reports the recorded error if it fails instead. */
async function readyWorkspace(
    test: ProjectTestHarness,
    projectId: string,
    workspaceId: string,
): Promise<Workspace> {
    return await waitFor(async () => {
        const current = await ownedWorkspace(test, test, projectId, workspaceId);
        if (current?.status === "failed") {
            throw new Error(`The workspace failed to be created: ${current.initializationError}`);
        }
        return current?.status === "ready" ? current : undefined;
    }, "the workspace to be ready");
}

describe("creating a workspace", () => {
    it("cuts a real worktree on its own branch from the project's trunk", async () => {
        const test = await harness("workspace-create");
        const project = await readyProject(test);

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        expect(reserved).toBeDefined();
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        expect(workspace.kind).toBe("git_worktree");
        expect(workspace.path.startsWith(test.managedWorkspaces)).toBe(true);
        expect(existsSync(join(workspace.path, "README.md"))).toBe(true);
        expect(await git(workspace.path, "branch", "--show-current")).toBe(workspace.branch);
        expect(workspace.branch.startsWith("worktree/")).toBe(true);
        expect(workspace.baseCommit).toBe(await git(project.path, "rev-parse", "HEAD"));
        expect(workspace.baseRef).toBeDefined();
    });

    it("forks from a base reference the caller asked for", async () => {
        const test = await harness("workspace-base-ref");
        const project = await readyProject(test);
        await git(project.path, "checkout", "-b", "release");
        await writeFile(join(project.path, "RELEASE.md"), "release\n");
        await git(project.path, "add", ".");
        await git(project.path, "commit", "-m", "release");
        const releaseCommit = await git(project.path, "rev-parse", "HEAD");
        await git(project.path, "checkout", "main");

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            baseRef: "release",
            name: "Hotfix",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        expect(workspace.baseCommit).toBe(releaseCommit);
        expect(existsSync(join(workspace.path, "RELEASE.md"))).toBe(true);
    });

    it("picks a different branch when the obvious one is already a Git branch", async () => {
        const test = await harness("workspace-branch-collision");
        const project = await readyProject(test);
        await git(project.path, "branch", "worktree/login-flow");

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        expect(workspace.branch).not.toBe("worktree/login-flow");
        expect(await git(workspace.path, "branch", "--show-current")).toBe(workspace.branch);
    });

    it("picks a different folder key when the obvious folder is taken", async () => {
        const test = await harness("workspace-storage-collision");
        const project = await readyProject(test);
        const projectRow = await test.projects.get(test.ctx, project.id);
        const squatted = join(test.managedWorkspaces, projectRow!.storageKey, "login-flow");
        await mkdir(squatted, { recursive: true });

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        expect(workspace.path).not.toBe(squatted);
        expect(existsSync(join(workspace.path, "README.md"))).toBe(true);
    });

    it("answers a repeated request with the workspace the first one made", async () => {
        const test = await harness("workspace-idempotent");
        const project = await readyProject(test);
        const first = await test.workspaces.createWorkspace(test.ctx, project.id, {
            id: "c" + "abcdefghijklmnopqrstuvw",
            name: "Login flow",
        });
        await readyWorkspace(test, project.id, first!.id);

        const again = await test.workspaces.createWorkspace(test.ctx, project.id, {
            id: first!.id,
            name: "Login flow",
        });

        expect(again!.id).toBe(first!.id);
        const listed = await test.workspaces.list(test.ctx, { projectRef: project.id });
        expect(listed.length).toBe(1);
    });

    it("refuses a repeat that means something different from the reservation", async () => {
        const test = await harness("workspace-conflicting-replay");
        const project = await readyProject(test);
        await git(project.path, "branch", "release");
        const first = await test.workspaces.createWorkspace(test.ctx, project.id, {
            baseRef: "main",
            name: "Login flow",
        });
        await readyWorkspace(test, project.id, first!.id);

        await expect(
            test.workspaces.createWorkspace(test.ctx, project.id, {
                baseRef: "release",
                id: first!.id,
                name: "Login flow",
            }),
        ).rejects.toThrow(/different base/u);
    });

    it("runs the project's setup commands and replicates its sync files", async () => {
        const test = await harness("workspace-setup");
        const project = await readyProject(test);
        await writeFile(join(project.path, ".env"), "TOKEN=root\n");
        // The setup commands are read from the workspace, so the configuration has to be part of
        // the checkout. The sync list is read from the project root the copy comes from.
        await writeFile(
            join(project.path, "rig.toml"),
            [
                "[workspace]",
                'sync = [".env"]',
                'setup_commands = ["echo ran > setup-ran.txt"]',
                "",
            ].join("\n"),
        );
        await git(project.path, "add", ".");
        await git(project.path, "commit", "-m", "configure workspaces");

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Setup",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        expect(await readFile(join(workspace.path, ".env"), "utf8")).toBe("TOKEN=root\n");
        expect(await readFile(join(workspace.path, "setup-ran.txt"), "utf8")).toBe("ran\n");
    });

    it("records why a workspace could not be created rather than losing the reservation", async () => {
        const test = await harness("workspace-setup-failure");
        const project = await readyProject(test);
        await writeFile(
            join(project.path, "rig.toml"),
            ["[workspace]", 'setup_commands = ["exit 3"]', ""].join("\n"),
        );
        await git(project.path, "add", ".");
        await git(project.path, "commit", "-m", "a setup command that fails");

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Doomed",
        });
        const failed = await waitFor(async () => {
            const current = await ownedWorkspace(test, test, project.id, reserved!.id);
            return current?.status === "failed" ? current : undefined;
        }, "the workspace to record its failure");

        expect(failed.initializationError).toBeDefined();
        expect(failed.initializationError).not.toBe("");
    });
});

describe("resuming an interrupted creation", () => {
    it("puts the worktree on the base commit the reservation promised", async () => {
        const paused = pausableGit((args) => args[0] === "worktree" && args[1] === "add");
        const test = await harness("workspace-resume", { git: paused.runner });
        const project = await readyProject(test);

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Interrupted",
        });
        await paused.paused;
        const interrupted = await waitFor(async () => {
            const current = await ownedWorkspace(test, test, project.id, reserved!.id);
            return current?.baseCommit === undefined ? undefined : current;
        }, "the workspace to record the commit it was reserved on");
        expect(interrupted.status).toBe("initializing");
        const promisedBase = interrupted.baseCommit;

        // Rig goes down while Git is mid-checkout, so nothing marks the workspace failed and it
        // stays exactly where it was: reserved, promised a commit, and without a folder.
        const closing = test.close(test.ctx);
        paused.release();
        await closing;
        expect((await ownedWorkspace(test, test, project.id, reserved!.id))?.status).toBe(
            "initializing",
        );

        // The project's trunk moves on before Rig comes back.
        await writeFile(join(project.path, "later.md"), "later\n");
        await git(project.path, "add", ".");
        await git(project.path, "commit", "-m", "later");
        expect(await git(project.path, "rev-parse", "HEAD")).not.toBe(promisedBase);

        const restarted = test.restart({ git: undefined });
        await restarted.workspaces.reconcileInitializingWorkspaces(test.ctx);
        const resumed = await waitFor(async () => {
            const current = await ownedWorkspace(test, restarted, project.id, reserved!.id);
            return current?.status === "ready" ? current : undefined;
        }, "the interrupted workspace to be finished");

        expect(resumed.baseCommit).toBe(promisedBase);
        expect(await git(resumed.path, "rev-parse", "HEAD")).toBe(promisedBase);
        expect(existsSync(join(resumed.path, "later.md"))).toBe(false);
    });
});

describe("renaming a workspace", () => {
    it("moves the Git branch after the name is stored", async () => {
        const test = await harness("workspace-rename");
        const project = await readyProject(test);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);
        const oldBranch = workspace.branch;

        const renamed = await test.workspaces.rename(test.ctx, {
            workspaceId: workspace.id,
            name: "Payment flow",
        });

        expect(renamed.name).toBe("Payment flow");
        expect(renamed.branch).not.toBe(oldBranch);
        await waitFor(
            async () =>
                (await git(workspace.path, "branch", "--show-current")) === renamed.branch
                    ? true
                    : undefined,
            "Git to follow the workspace rename",
        );
    });

    it("keeps the name a person chose when a chat suggests another one", async () => {
        const test = await harness("workspace-inherit");
        const project = await readyProject(test);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
            nameConfigured: true,
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        const named = await test.workspaces.inheritName(test.ctx, {
            workspaceId: workspace.id,
            name: "Something a model invented",
        });

        expect(named.name).toBe("Login flow");
    });
});

describe("archiving a workspace", () => {
    it("removes the worktree and prunes it out of the project", async () => {
        const test = await harness("workspace-archive");
        const project = await readyProject(test);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        await test.workspaces.beginArchive(test.ctx, workspace.id);
        const archived = await test.workspaces.removeArchivedWorkspace(
            test.ctx,
            project.id,
            workspace.id,
        );

        expect(archived!.status).toBe("archived");
        expect(existsSync(workspace.path)).toBe(false);
        expect(await git(project.path, "worktree", "list", "--porcelain")).not.toContain(
            workspace.path,
        );
    });

    it("keeps the workspace archived even when the folder cannot be removed", async () => {
        const cleanupErrors: string[] = [];
        const test = await harness("workspace-archive-failure", {
            onWorkspaceHostError: (_workspaceId, _kind, message) => cleanupErrors.push(message),
        });
        const project = await readyProject(test);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);
        // Replace the folder with a file: cleanup refuses to touch anything that is not the
        // directory it reserved, so removal fails while archival must still stand.
        await git(project.path, "worktree", "remove", "--force", workspace.path);
        await writeFile(workspace.path, "not a workspace\n");

        await test.workspaces.beginArchive(test.ctx, workspace.id);
        const archived = await test.workspaces.removeArchivedWorkspace(
            test.ctx,
            project.id,
            workspace.id,
        );

        expect(archived!.status).toBe("archived");
        expect(cleanupErrors.length).toBe(1);
        expect(existsSync(workspace.path)).toBe(true);
        await rm(workspace.path, { force: true });
    });

    it("archives a project's workspaces along with it", async () => {
        const test = await harness("project-archive");
        const project = await readyProject(test);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        await test.projects.archive(test.ctx, project.id);

        const after = await waitFor(async () => {
            const current = await ownedWorkspace(test, test, project.id, workspace.id);
            return current?.status === "archived" ? current : undefined;
        }, "the project's workspace to be archived");
        expect(after.status).toBe("archived");
        expect(existsSync(workspace.path)).toBe(false);
    });
});

describe("a project Git cannot cut a worktree from", () => {
    it("gets a copy of the folder instead", async () => {
        const test = await harness("workspace-copy");
        const path = join(test.root, "notes");
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "todo.md"), "buy milk\n");
        const { project } = await test.workspaces.resolvePath(test.ctx, path);
        await waitFor(async () => {
            const current = await test.projects.get(test.ctx, project.id);
            return current?.initializationStatus === "ready" ? current : undefined;
        }, "the plain folder project to be set up");

        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Groceries",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        expect(workspace.kind).toBe("directory");
        expect(await readFile(join(workspace.path, "todo.md"), "utf8")).toBe("buy milk\n");
    });

    it("keeps the copied folder on archive by default, because it is the person's own work", async () => {
        const test = await harness("workspace-copy-keep");
        const path = join(test.root, "notes");
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "todo.md"), "buy milk\n");
        const { project } = await test.workspaces.resolvePath(test.ctx, path);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Groceries",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        await test.workspaces.beginArchive(test.ctx, workspace.id);
        await test.workspaces.removeArchivedWorkspace(test.ctx, project.id, workspace.id);

        expect(existsSync(join(workspace.path, "todo.md"))).toBe(true);
    });

    it("deletes the copied folder when the settings say not to keep it", async () => {
        const test = await harness("workspace-copy-delete", {
            settings: {
                keepCopiesOnArchive: false,
                keepWorktreesOnArchive: false,
                protectedSync: [],
                setupCommands: [],
                sync: [],
            },
        });
        const path = join(test.root, "notes");
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "todo.md"), "buy milk\n");
        const { project } = await test.workspaces.resolvePath(test.ctx, path);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Groceries",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        await test.workspaces.beginArchive(test.ctx, workspace.id);
        await test.workspaces.removeArchivedWorkspace(test.ctx, project.id, workspace.id);

        expect(existsSync(workspace.path)).toBe(false);
    });

    it("keeps a worktree folder when the settings ask for it", async () => {
        const test = await harness("workspace-worktree-keep", {
            settings: {
                keepCopiesOnArchive: true,
                keepWorktreesOnArchive: true,
                protectedSync: [],
                setupCommands: [],
                sync: [],
            },
        });
        const project = await readyProject(test);
        const reserved = await test.workspaces.createWorkspace(test.ctx, project.id, {
            name: "Login flow",
        });
        const workspace = await readyWorkspace(test, project.id, reserved!.id);

        await test.workspaces.beginArchive(test.ctx, workspace.id);
        await test.workspaces.removeArchivedWorkspace(test.ctx, project.id, workspace.id);

        expect(existsSync(join(workspace.path, "README.md"))).toBe(true);
    });
});

describe("moving a session between workspaces", () => {
    it("prepares the target and refuses a move onto the same workspace", async () => {
        const test = await harness("workspace-transfer");
        const project = await readyProject(test);
        const sourceReserved = await test.workspaces.createWorkspace(
            test.ctx,
            project.id,
            { name: "Source" },
        );
        const targetReserved = await test.workspaces.createWorkspace(
            test.ctx,
            project.id,
            { name: "Target" },
        );
        const source = await readyWorkspace(test, project.id, sourceReserved!.id);
        const target = await readyWorkspace(test, project.id, targetReserved!.id);

        await expect(
            test.workspaces.validateSessionTransfer(
                test.ctx,
                project.id,
                source.id,
                source.id,
            ),
        ).rejects.toThrow(/different workspace/u);

        const moved = await test.workspaces.prepareSessionTransfer(
            test.ctx,
            project.id,
            source.id,
            target.id,
        );

        expect(moved.target.id).toBe(target.id);
        expect(moved.prepared.state.status).toBe("prepared");
        await moved.prepared.commitTransfer();
        expect(existsSync(moved.target.path)).toBe(true);
    });
});
