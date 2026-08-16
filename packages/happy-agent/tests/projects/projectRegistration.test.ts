import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectRegistrationError } from "../../sources/modules/projects/ProjectRegistrationError.js";
import { createGitRepository, projectTestHarness, type ProjectTestHarness } from "./support.js";

const open: ProjectTestHarness[] = [];

async function harness(name: string): Promise<ProjectTestHarness> {
    const created = await projectTestHarness(name);
    open.push(created);
    return created;
}

afterEach(async () => {
    await Promise.all(open.splice(0).map((created) => created.dispose()));
});

describe("resolving a working directory", () => {
    it("imports an unknown Git folder as a project named after it", async () => {
        const test = await harness("resolve-import");
        const path = await createGitRepository(join(test.root, "acme-api"));

        const { project, workspace } = await test.service.resolve(test.ctx, path);

        expect(workspace).toBeUndefined();
        expect(project.name).toBe("acme-api");
        expect(project.kind).toBe("regular");
        expect(project.repositoryRef).toBe(path);
        expect(project.nameSource).toBe("folder");
    });

    it("answers with the project it already made rather than making a second one", async () => {
        const test = await harness("resolve-idempotent");
        const path = await createGitRepository(join(test.root, "acme-api"));

        const first = await test.service.resolve(test.ctx, path);
        const second = await test.service.resolve(test.ctx, path);

        expect(second.project.id).toBe(first.project.id);
        expect((await test.service.listProjects(test.ctx)).length).toBe(1);
    });

    it("treats the home directory as its own kind of project and never sets it up", async () => {
        const test = await harness("resolve-home");

        const { project } = await test.service.resolve(test.ctx, test.home);

        expect(project.kind).toBe("home");
        expect(project.name).toBe("Home");
        expect(project.initializationStatus).toBe("ready");
    });

    it("imports a folder that is not a repository at all", async () => {
        const test = await harness("resolve-plain");
        const path = join(test.root, "notes");
        await mkdir(path, { recursive: true });

        const { project } = await test.service.resolve(test.ctx, path);

        expect(project.name).toBe("notes");
        expect(project.repositoryRef).toBe(path);
    });

    it("follows a symlink so one folder cannot become two projects", async () => {
        const test = await harness("resolve-symlink");
        const path = await createGitRepository(join(test.root, "acme-api"));
        const alias = join(test.root, "alias");
        await symlink(path, alias);

        const direct = await test.service.resolve(test.ctx, path);
        const viaAlias = await test.service.resolve(test.ctx, alias);

        expect(viaAlias.project.id).toBe(direct.project.id);
    });

    it("restores an archived project instead of refusing to work in its folder", async () => {
        const test = await harness("resolve-archived");
        const path = await createGitRepository(join(test.root, "acme-api"));
        const { project } = await test.service.resolve(test.ctx, path);
        await test.service.archiveProject(test.ctx, project.id);
        expect((await test.service.getProject(test.ctx, project.id))?.status).toBe("archived");

        const again = await test.service.resolve(test.ctx, path);

        expect(again.project.id).toBe(project.id);
        expect(again.project.status).toBe("active");
    });

    it("honours a requested identity only for a folder it is importing now", async () => {
        const test = await harness("resolve-requested-id");
        const first = await createGitRepository(join(test.root, "one"));
        const second = await createGitRepository(join(test.root, "two"));
        const requested = createId();

        const imported = await test.service.resolve(test.ctx, first, undefined, requested);
        expect(imported.project.id).toBe(requested);

        // The folder already is a project, so its identity stands and the request is ignored.
        const existing = await test.service.resolve(test.ctx, first, undefined, createId());
        expect(existing.project.id).toBe(requested);

        await expect(
            test.service.resolve(test.ctx, second, undefined, requested),
        ).rejects.toThrow();
    });
});

describe("registering a project explicitly", () => {
    it("accepts the top level of a real repository", async () => {
        const test = await harness("register-ok");
        const path = await createGitRepository(join(test.root, "acme-api"));

        const project = await test.service.registerProject(test.ctx, { path });

        expect(project.repositoryRef).toBe(path);
        expect(project.name).toBe("acme-api");
    });

    it("refuses a relative path", async () => {
        const test = await harness("register-relative");

        await expect(
            test.service.registerProject(test.ctx, { path: "acme-api" }),
        ).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("refuses an identity that is not a cuid2", async () => {
        const test = await harness("register-bad-id");
        const path = await createGitRepository(join(test.root, "acme-api"));

        await expect(
            test.service.registerProject(test.ctx, { path, projectId: "not an id" }),
        ).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("refuses a path that does not exist", async () => {
        const test = await harness("register-missing");

        await expect(
            test.service.registerProject(test.ctx, { path: join(test.root, "nowhere") }),
        ).rejects.toMatchObject({ code: "path_missing" });
    });

    it("refuses a file", async () => {
        const test = await harness("register-file");
        const path = join(test.root, "notes.md");
        await writeFile(path, "# Notes\n");

        await expect(test.service.registerProject(test.ctx, { path })).rejects.toMatchObject({
            code: "not_directory",
        });
    });

    it("refuses a folder that is not a Git repository", async () => {
        const test = await harness("register-not-git");
        const path = join(test.root, "notes");
        await mkdir(path, { recursive: true });

        await expect(test.service.registerProject(test.ctx, { path })).rejects.toMatchObject({
            code: "not_git_repository",
        });
    });

    it("refuses a subfolder of a repository, because it does not own the branches", async () => {
        const test = await harness("register-subfolder");
        const repository = await createGitRepository(join(test.root, "acme-api"));
        const inside = join(repository, "packages", "api");
        await mkdir(inside, { recursive: true });

        await expect(
            test.service.registerProject(test.ctx, { path: inside }),
        ).rejects.toMatchObject({ code: "not_git_top_level" });
    });

    it("refuses an identity that already names another folder", async () => {
        const test = await harness("register-conflict");
        const first = await createGitRepository(join(test.root, "one"));
        const second = await createGitRepository(join(test.root, "two"));
        const projectId = createId();
        await test.service.registerProject(test.ctx, { path: first, projectId });

        await expect(
            test.service.registerProject(test.ctx, { path: second, projectId }),
        ).rejects.toMatchObject({ code: "project_id_conflict" });
    });

    it("answers with the project a folder already has when it is registered again", async () => {
        const test = await harness("register-again");
        const path = await createGitRepository(join(test.root, "acme-api"));
        const first = await test.service.registerProject(test.ctx, { path });

        const again = await test.service.registerProject(test.ctx, { path });

        expect(again.id).toBe(first.id);
    });

    it("reports registration failures as a typed error a route can turn into a status", async () => {
        const test = await harness("register-typed");

        const error = await test.service
            .registerProject(test.ctx, { path: join(test.root, "nowhere") })
            .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(ProjectRegistrationError);
        expect((error as ProjectRegistrationError).message).toMatch(/[a-z] [a-z]/u);
    });
});
