import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceNameKind } from "../../sources/modules/projects/generateWorkspaceNames.js";
import { withPreservedNumericPrefix } from "../../sources/modules/projects/generateWorkspaceNames.js";
import {
    createGitRepository,
    git,
    projectTestHarness,
    waitFor,
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

async function readyProject(
    test: ProjectTestHarness,
    folder = "acme-api",
): Promise<{ id: string; path: string }> {
    const path = await createGitRepository(join(test.root, folder));
    const { project } = await test.service.resolve(test.ctx, path);
    await waitFor(async () => {
        const current = await test.service.getProject(test.ctx, project.id);
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
    const reserved = await test.service.createWorkspace(test.ctx, projectId, {
        name,
        ...(nameConfigured === undefined ? {} : { nameConfigured }),
    });
    return await waitFor(async () => {
        const current = await test.service.getWorkspace(test.ctx, projectId, reserved!.id);
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

        const renamed = await test.service.renameProject(test.ctx, first.id, "Acme API");
        expect(renamed!.name).toBe("Acme API");
        expect(renamed!.nameSource).toBe("user");

        const moved = await test.service.reorderProject(test.ctx, first.id, second.id);
        expect(moved).toBeDefined();
        const order = (await test.service.listProjects(test.ctx)).map((project) => project.id);
        expect(order.indexOf(first.id)).toBeGreaterThan(order.indexOf(second.id));
    });

    it("refuses a name that is only invisible characters or far too long", async () => {
        const test = await harness("project-rename-invalid");
        const project = await readyProject(test);

        await expect(test.service.renameProject(test.ctx, project.id, "   ")).rejects.toThrow();
        await expect(
            test.service.renameProject(test.ctx, project.id, "a".repeat(101)),
        ).rejects.toThrow();
        await expect(
            test.service.renameProject(test.ctx, project.id, "Acme\u0007API"),
        ).rejects.toThrow();
    });

    it("archives and brings a project back", async () => {
        const test = await harness("project-archive-restore");
        const project = await readyProject(test);

        await test.service.archiveProject(test.ctx, project.id);
        expect((await test.service.getProject(test.ctx, project.id))?.status).toBe("archived");

        const restored = await test.service.unarchiveProject(test.ctx, project.id);
        expect(restored!.status).toBe("active");
    });

    it("records the trunk workspaces are cut from", async () => {
        const test = await harness("project-default-branch");
        const project = await readyProject(test);

        expect((await test.service.getProject(test.ctx, project.id))?.defaultBranch).toBe("main");
    });

    it("re-derives Git facts for a project whose branch moved underneath it", async () => {
        const test = await harness("project-git-facts");
        const project = await readyProject(test);
        await git(project.path, "checkout", "-b", "feature");

        await test.service.reconcileGitFacts(test.ctx);

        const current = await test.service.getProject(test.ctx, project.id);
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

        await test.service.reconcileGitFacts(test.ctx);

        expect((await test.service.getProject(test.ctx, project.id))?.presence).toBe("missing");
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

        const withAvatar = await test.service.setAvatar(test.ctx, project.id, "user", png);

        expect(withAvatar!.avatar?.mediaType).toBe("image/webp");
        expect(withAvatar!.avatar?.width).toBe(256);
        expect(withAvatar!.avatar?.source).toBe("user");
        const asset = await test.service.avatarAsset(test.ctx, withAvatar!.avatar!.hash);
        expect(asset?.mediaType).toBe("image/webp");
        expect(asset!.bytes.byteLength).toBeGreaterThan(0);
    });

    it("refuses an image larger than the limit and one that is not a picture", async () => {
        const test = await harness("project-avatar-invalid");
        const project = await readyProject(test);

        await expect(
            test.service.setAvatar(test.ctx, project.id, "user", Buffer.alloc(9 * 1024 * 1024, 1)),
        ).rejects.toThrow(/larger than the allowed limit/u);
        await expect(
            test.service.setAvatar(test.ctx, project.id, "user", Buffer.from("not a picture")),
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
        const withAvatar = await test.service.setAvatar(test.ctx, project.id, "user", png);
        const hash = withAvatar!.avatar!.hash;
        const storedFile = join(
            test.stateDirectory,
            "assets",
            "project-avatars",
            hash.slice(0, 2),
            `${hash}.webp`,
        );
        expect(existsSync(storedFile)).toBe(true);

        await test.service.clearAvatar(test.ctx, project.id);
        expect((await test.service.getProject(test.ctx, project.id))?.avatar).toBeUndefined();

        // Collection is delayed, so a picture cleared by mistake can still be put back.
        await test.service.collectAvatarGarbage(test.ctx);
        expect(existsSync(storedFile)).toBe(true);

        clock += 25 * 60 * 60 * 1000;
        await test.service.collectAvatarGarbage(test.ctx);
        expect(existsSync(storedFile)).toBe(false);
    });
});

describe("naming a workspace from the first message", () => {
    it("asks for the three names separately and applies the workspace one", async () => {
        const asked: WorkspaceNameKind[] = [];
        const test = await harness("naming", {
            nameGenerator: {
                suggest: async (_ctx, request) => {
                    asked.push(request.kind);
                    if (request.kind === "branch") return "fix-login-redirect";
                    if (request.kind === "chat") return "Fixing the login redirect";
                    return "Login redirect";
                },
            },
        });
        const project = await readyProject(test);
        const workspace = await readyWorkspace(test, project.id, "3 Untitled");

        const named = await test.service.nameFromFirstMessage(test.ctx, {
            firstMessage: "The login page redirects in a loop.",
            projectId: project.id,
            workspaceId: workspace.id,
        });

        expect(new Set(asked)).toEqual(new Set(["branch", "chat", "workspace"]));
        expect(named.branch).toBe("fix-login-redirect");
        expect(named.chat).toBe("Fixing the login redirect");
        expect(named.workspace?.name).toBe("3 Login redirect");
    });

    it("leaves a workspace and a chat a person already named alone", async () => {
        const asked: WorkspaceNameKind[] = [];
        const test = await harness("naming-configured", {
            nameGenerator: {
                suggest: async (_ctx, request) => {
                    asked.push(request.kind);
                    return "Something a model invented";
                },
            },
        });
        const project = await readyProject(test);
        const workspace = await readyWorkspace(test, project.id, "Login flow", true);

        const named = await test.service.nameFromFirstMessage(test.ctx, {
            firstMessage: "The login page redirects in a loop.",
            projectId: project.id,
            sessionNamed: true,
            workspaceId: workspace.id,
        });

        expect(asked).toEqual([]);
        expect(named).toEqual({});
        expect((await test.service.getWorkspace(test.ctx, project.id, workspace.id))?.name).toBe(
            "Login flow",
        );
    });

    it("names nothing when the session layer offered no way to generate names", async () => {
        const test = await harness("naming-absent");
        const project = await readyProject(test);
        const workspace = await readyWorkspace(test, project.id, "Untitled");

        expect(
            await test.service.nameFromFirstMessage(test.ctx, {
                firstMessage: "Hello",
                projectId: project.id,
                workspaceId: workspace.id,
            }),
        ).toEqual({});
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
        await test.service.close(test.ctx);

        const restarted = test.restart();
        await restarted.open(test.ctx);

        expect((await restarted.getWorkspace(test.ctx, project.id, workspace.id))?.status).toBe(
            "ready",
        );
        expect((await restarted.getProject(test.ctx, project.id))?.initializationStatus).toBe(
            "ready",
        );
    });

    it("replicates the sync files into a workspace made before they existed", async () => {
        const test = await harness("startup-sync");
        const project = await readyProject(test);
        const workspace = await readyWorkspace(test, project.id, "Login flow");
        await test.service.close(test.ctx);

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
        const { project } = await test.service.resolve(test.ctx, path);
        await test.service.close(test.ctx);
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true, recursive: true });

        const restarted = test.restart();
        await restarted.open(test.ctx);

        const settled = await waitFor(async () => {
            const current = await restarted.getProject(test.ctx, project.id);
            return current?.initializationStatus === "initializing" ? undefined : current;
        }, "the project to stop being set up");
        expect(settled.initializationStatus).toBe("failed");
        expect(settled.initializationError).toBeDefined();
    });
});
