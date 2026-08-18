import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withPreservedNumericPrefix, type Workspace } from "@slopus/happy-agent-modules";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
    AGENT_ID,
    createGitRepository,
    git,
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
    const workspace = await catalogs.workspaces.get(test.ctx, AGENT_ID, workspaceId);
    return workspace?.projectRef === projectId ? workspace : undefined;
}

async function readyProject(
    test: ProjectTestHarness,
    folder = "acme-api",
): Promise<{ id: string; path: string }> {
    const path = await createGitRepository(join(test.root, folder));
    const { project } = await test.workspaces.resolvePath(test.ctx, AGENT_ID, path);
    await waitFor(async () => {
        const current = await test.projects.get(test.ctx, AGENT_ID, project.id);
        return current?.initializationStatus === "ready" ? current : undefined;
    }, `project ${folder} to be set up`);
    return { id: project.id, path };
}

async function readyWorkspace(
    test: ProjectTestHarness,
    projectId: string,
    name: string,
    nameConfigured?: boolean,
) {
    const reserved = await test.workspaces.createWorkspace(test.ctx, AGENT_ID, projectId, {
        name,
        ...(nameConfigured === undefined ? {} : { nameConfigured }),
    });
    return await waitFor(async () => {
        const current = await ownedWorkspace(test, test, projectId, reserved!.id);
        if (current?.status === "failed") {
            throw new Error(`The workspace failed: ${current.initializationError}`);
        }
        return current?.status === "ready" ? current : undefined;
    }, "the workspace to be ready");
}

describe("projects", () => {
    it("renames and reorders a project", async () => {
        const test = await harness("project-rename");
        const first = await readyProject(test, "one");
        const second = await readyProject(test, "two");

        const renamed = await test.projects.rename(test.ctx, AGENT_ID, {
            projectId: first.id,
            name: "Acme API",
        });
        expect(renamed.name).toBe("Acme API");
        expect(renamed.nameSource).toBe("user");

        const moved = await test.projects.reorder(test.ctx, AGENT_ID, {
            projectId: first.id,
            afterId: second.id,
        });
        expect(moved).toBeDefined();
        const page = await test.projects.list(test.ctx, AGENT_ID, { includeArchived: true });
        const order = page.projects.map((project) => project.id);
        expect(order.indexOf(first.id)).toBeGreaterThan(order.indexOf(second.id));
    });

    it("refuses a name carrying characters a person cannot see", async () => {
        const test = await harness("project-rename-invalid");
        const project = await readyProject(test);

        await expect(
            test.projects.rename(test.ctx, AGENT_ID, {
                projectId: project.id,
                name: "Acme\u0007API",
            }),
        ).rejects.toThrow();
    });

    it("archives and brings a project back", async () => {
        const test = await harness("project-archive-restore");
        const project = await readyProject(test);

        await test.projects.archive(test.ctx, AGENT_ID, project.id);
        expect((await test.projects.get(test.ctx, AGENT_ID, project.id))?.status).toBe("archived");

        const restored = await test.projects.restore(test.ctx, AGENT_ID, project.id);
        expect(restored.status).toBe("active");
    });

    it("records the trunk workspaces are cut from", async () => {
        const test = await harness("project-default-branch");
        const project = await readyProject(test);

        expect((await test.projects.get(test.ctx, AGENT_ID, project.id))?.defaultBranch).toBe(
            "main",
        );
    });

    it("re-derives Git facts for a project whose branch moved underneath it", async () => {
        const test = await harness("project-git-facts");
        const project = await readyProject(test);
        await git(project.path, "checkout", "-b", "feature");

        await test.projects.reconcileGitFacts(test.ctx, AGENT_ID);

        const current = await test.projects.get(test.ctx, AGENT_ID, project.id);
        expect(current?.gitBranch).toBe("feature");
        expect(current?.presence).toBe("present");
        expect(current?.worktreeSupport).toBe("supported");
    });

    it("notices a project folder that is gone", async () => {
        const test = await harness("project-missing");
        const project = await readyProject(test);
        await git(project.path, "checkout", "main");
        const { rm } = await import("node:fs/promises");
        await rm(project.path, { force: true, recursive: true });

        await test.projects.reconcileGitFacts(test.ctx, AGENT_ID);

        expect((await test.projects.get(test.ctx, AGENT_ID, project.id))?.presence).toBe("missing");
    });
});

describe("project pictures", () => {
    it("stores a normalized picture and serves its bytes back", async () => {
        const test = await harness("project-avatar");
        const project = await readyProject(test);
        const png = await sharp({
            create: { background: "#3366ff", channels: 3, height: 512, width: 512 },
        })
            .png()
            .toBuffer();

        const withAvatar = await test.projects.storeAvatarImage(
            test.ctx,
            AGENT_ID,
            project.id,
            "user",
            png,
        );

        expect(withAvatar!.avatar?.mediaType).toBe("image/webp");
        expect(withAvatar!.avatar?.width).toBe(256);
        expect(withAvatar!.avatar?.source).toBe("user");
        const asset = await test.projects.avatarAsset(test.ctx, AGENT_ID, withAvatar!.avatar!.hash);
        expect(asset?.mediaType).toBe("image/webp");
        expect(asset!.bytes.byteLength).toBeGreaterThan(0);
    });

    it("refuses an image larger than the limit and one that is not a picture", async () => {
        const test = await harness("project-avatar-invalid");
        const project = await readyProject(test);

        await expect(
            test.projects.storeAvatarImage(
                test.ctx,
                AGENT_ID,
                project.id,
                "user",
                Buffer.alloc(9 * 1024 * 1024, 1),
            ),
        ).rejects.toThrow(/larger than the allowed limit/u);
        await expect(
            test.projects.storeAvatarImage(
                test.ctx,
                AGENT_ID,
                project.id,
                "user",
                Buffer.from("not a picture"),
            ),
        ).rejects.toThrow();
    });

    it("clears a picture and eventually forgets the bytes nothing points at", async () => {
        let clock = Date.now();
        const test = await harness("project-avatar-gc", { now: () => clock });
        const project = await readyProject(test);
        const png = await sharp({
            create: { background: "#3366ff", channels: 3, height: 64, width: 64 },
        })
            .png()
            .toBuffer();
        const withAvatar = await test.projects.storeAvatarImage(
            test.ctx,
            AGENT_ID,
            project.id,
            "user",
            png,
        );
        const hash = withAvatar!.avatar!.hash;
        const storedFile = join(
            test.stateDirectory,
            "assets",
            "project-avatars",
            hash.slice(0, 2),
            `${hash}.webp`,
        );
        expect(existsSync(storedFile)).toBe(true);

        await test.projects.clearAvatar(test.ctx, AGENT_ID, { projectId: project.id });
        expect((await test.projects.get(test.ctx, AGENT_ID, project.id))?.avatar).toBeUndefined();

        // Collection is delayed, so a picture cleared by mistake can still be put back.
        await test.projects.collectAvatarGarbage(test.ctx, AGENT_ID);
        expect(existsSync(storedFile)).toBe(true);

        clock += 25 * 60 * 60 * 1000;
        await test.projects.collectAvatarGarbage(test.ctx, AGENT_ID);
        expect(existsSync(storedFile)).toBe(false);
    });
});

describe("withPreservedNumericPrefix", () => {
    it("keeps the number a person tells workspaces apart by", () => {
        expect(withPreservedNumericPrefix("12 Untitled", "Login redirect")).toBe(
            "12 Login redirect",
        );
        expect(withPreservedNumericPrefix("workspace-7", "Login redirect")).toBe("Login redirect");
        expect(withPreservedNumericPrefix("07_untitled", "Login redirect")).toBe(
            "07_Login redirect",
        );
        expect(withPreservedNumericPrefix("Untitled", "Login redirect")).toBe("Login redirect");
    });
});

describe("starting up again", () => {
    it("finishes projects and workspaces the last run left half-made", async () => {
        const test = await harness("startup");
        const project = await readyProject(test);
        const workspace = await readyWorkspace(test, project.id, "Login flow");
        await test.close(test.ctx);

        const restarted = test.restart();
        await restarted.open(test.ctx);

        expect((await ownedWorkspace(test, restarted, project.id, workspace.id))?.status).toBe(
            "ready",
        );
        expect(
            (await restarted.projects.get(test.ctx, AGENT_ID, project.id))?.initializationStatus,
        ).toBe("ready");
    });

    it("replicates the sync files into a workspace made before they existed", async () => {
        const test = await harness("startup-sync");
        const project = await readyProject(test);
        const workspace = await readyWorkspace(test, project.id, "Login flow");
        await test.close(test.ctx);

        await writeFile(join(project.path, ".env"), "TOKEN=root\n");
        await writeFile(
            join(project.path, "rig.toml"),
            ["[workspace]", 'sync = [".env"]', ""].join("\n"),
        );

        const restarted = test.restart();
        await restarted.open(test.ctx);

        await waitFor(
            async () => (existsSync(join(workspace.path, ".env")) ? true : undefined),
            "the sync pass to reach the workspace",
        );
    });

    it("settles a project whose folder has since disappeared", async () => {
        const test = await harness("startup-missing");
        const path = join(test.root, "gone");
        await mkdir(path, { recursive: true });
        const { project } = await test.workspaces.resolvePath(test.ctx, AGENT_ID, path);
        await test.close(test.ctx);
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true, recursive: true });

        const restarted = test.restart();
        await restarted.open(test.ctx);

        const settled = await waitFor(async () => {
            const current = await restarted.projects.get(test.ctx, AGENT_ID, project.id);
            return current?.initializationStatus === "initializing" ? undefined : current;
        }, "the project to stop being set up");
        expect(settled.initializationStatus).toBe("failed");
        expect(settled.initializationError).toBeDefined();
    });
});
