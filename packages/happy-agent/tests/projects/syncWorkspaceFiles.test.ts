import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isPathLexicallyWithin, syncWorkspaceFiles } from "@slopus/happy-agent-modules";

const roots: string[] = [];

async function scratch(): Promise<{ project: string; workspace: string }> {
    const root = await mkdtemp(join(tmpdir(), "rig-sync-"));
    roots.push(root);
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    await mkdir(project, { recursive: true });
    await mkdir(workspace, { recursive: true });
    return { project, workspace };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("syncWorkspaceFiles", () => {
    it("copies a file from the project root into the workspace", async () => {
        const { project, workspace } = await scratch();
        await writeFile(join(project, ".env"), "TOKEN=1\n");

        await syncWorkspaceFiles({
            paths: [".env"],
            projectPath: project,
            workspacePath: workspace,
        });

        expect(await readFile(join(workspace, ".env"), "utf8")).toBe("TOKEN=1\n");
    });

    it("lets the project root win over whatever the workspace already had", async () => {
        const { project, workspace } = await scratch();
        await writeFile(join(project, ".env"), "TOKEN=root\n");
        await writeFile(join(workspace, ".env"), "TOKEN=stale\n");

        await syncWorkspaceFiles({
            paths: [".env"],
            projectPath: project,
            workspacePath: workspace,
        });

        expect(await readFile(join(workspace, ".env"), "utf8")).toBe("TOKEN=root\n");
    });

    it("copies directories and creates the parent folders a nested path needs", async () => {
        const { project, workspace } = await scratch();
        await mkdir(join(project, "config", "secrets"), { recursive: true });
        await writeFile(join(project, "config", "secrets", "key"), "value\n");

        await syncWorkspaceFiles({
            paths: ["config/secrets"],
            projectPath: project,
            workspacePath: workspace,
        });

        expect(await readFile(join(workspace, "config", "secrets", "key"), "utf8")).toBe("value\n");
    });

    it("replaces a destination whose kind changed", async () => {
        const { project, workspace } = await scratch();
        await mkdir(join(project, "config"), { recursive: true });
        await writeFile(join(project, "config", "a"), "a\n");
        await writeFile(join(workspace, "config"), "was a file\n");

        await syncWorkspaceFiles({
            paths: ["config"],
            projectPath: project,
            workspacePath: workspace,
        });

        expect(await readFile(join(workspace, "config", "a"), "utf8")).toBe("a\n");
    });

    it("skips a source that does not exist instead of failing the whole pass", async () => {
        const { project, workspace } = await scratch();
        await writeFile(join(project, "present"), "yes\n");

        await syncWorkspaceFiles({
            paths: ["missing", "present"],
            projectPath: project,
            workspacePath: workspace,
        });

        expect(await readFile(join(workspace, "present"), "utf8")).toBe("yes\n");
    });

    it("refuses a path that leaves the project", async () => {
        const { project, workspace } = await scratch();

        await expect(
            syncWorkspaceFiles({
                paths: ["../escape"],
                projectPath: project,
                workspacePath: workspace,
            }),
        ).rejects.toThrow(/stay inside the project/u);
    });

    it("skips a destination whose ancestor is a symlink pointing out of the workspace", async () => {
        const { project, workspace } = await scratch();
        const outside = join(workspace, "..", "outside");
        await mkdir(outside, { recursive: true });
        await writeFile(join(project, "config", ".keep"), "").catch(() => undefined);
        await mkdir(join(project, "config"), { recursive: true });
        await writeFile(join(project, "config", "key"), "secret\n");
        await symlink(outside, join(workspace, "config"));

        await syncWorkspaceFiles({
            paths: ["config/key"],
            projectPath: project,
            workspacePath: workspace,
        });

        await expect(readFile(join(outside, "key"), "utf8")).rejects.toThrow();
    });

    it("leaves a workspace that no longer exists alone rather than recreating it", async () => {
        const { project, workspace } = await scratch();
        await writeFile(join(project, ".env"), "TOKEN=1\n");
        await rm(workspace, { force: true, recursive: true });

        await syncWorkspaceFiles({
            paths: [".env"],
            projectPath: project,
            workspacePath: workspace,
        });

        await expect(readFile(join(workspace, ".env"), "utf8")).rejects.toThrow();
    });
});

describe("isPathLexicallyWithin", () => {
    it("accepts a descendant and rejects the folder itself, a sibling and an escape", () => {
        expect(isPathLexicallyWithin("/a/b", "/a/b/c")).toBe(true);
        expect(isPathLexicallyWithin("/a/b", "/a/b")).toBe(false);
        expect(isPathLexicallyWithin("/a/b", "/a/bc")).toBe(false);
        expect(isPathLexicallyWithin("/a/b", "/a")).toBe(false);
    });
});
