import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncWorkspaceFiles } from "../syncWorkspaceFiles.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function createRoots(): Promise<{ projectPath: string; workspacePath: string }> {
    const root = await mkdtemp(join(tmpdir(), "rig-workspace-sync-"));
    temporaryDirectories.push(root);
    const projectPath = join(root, "project");
    const workspacePath = join(root, "workspace");
    await Promise.all([mkdir(projectPath), mkdir(workspacePath)]);
    return { projectPath, workspacePath };
}

describe("syncWorkspaceFiles", () => {
    it("copies files and directories, creating missing parents", async () => {
        const { projectPath, workspacePath } = await createRoots();
        await mkdir(join(projectPath, "config", "secrets"), { recursive: true });
        await Promise.all([
            writeFile(join(projectPath, ".env"), "KEY=value\n"),
            writeFile(join(projectPath, "config", "secrets", "token.txt"), "token\n"),
        ]);

        await syncWorkspaceFiles({
            paths: [".env", "config/secrets"],
            projectPath,
            workspacePath,
        });

        await expect(readFile(join(workspacePath, ".env"), "utf8")).resolves.toBe("KEY=value\n");
        expect((await lstat(join(workspacePath, ".env"))).isSymbolicLink()).toBe(false);
        await expect(
            readFile(join(workspacePath, "config", "secrets", "token.txt"), "utf8"),
        ).resolves.toBe("token\n");
    });

    it("overwrites the workspace copy with the root copy and skips missing sources", async () => {
        const { projectPath, workspacePath } = await createRoots();
        await Promise.all([
            writeFile(join(projectPath, ".env"), "from root\n"),
            writeFile(join(workspacePath, ".env"), "workspace edit\n"),
        ]);

        await syncWorkspaceFiles({
            paths: [".env", "missing.txt"],
            projectPath,
            workspacePath,
        });

        await expect(readFile(join(workspacePath, ".env"), "utf8")).resolves.toBe("from root\n");
        await expect(lstat(join(workspacePath, "missing.txt"))).rejects.toThrow();
    });

    it("replaces a destination whose kind changed and follows source symlinks", async () => {
        const { projectPath, workspacePath } = await createRoots();
        await mkdir(join(projectPath, "shared"));
        await Promise.all([
            writeFile(join(projectPath, "shared", "inner.txt"), "inner\n"),
            writeFile(join(workspacePath, "shared"), "was a file\n"),
            writeFile(join(projectPath, "real.txt"), "real content\n"),
        ]);
        await symlink(join(projectPath, "real.txt"), join(projectPath, "aliased.txt"));

        await syncWorkspaceFiles({
            paths: ["shared", "aliased.txt"],
            projectPath,
            workspacePath,
        });

        await expect(readFile(join(workspacePath, "shared", "inner.txt"), "utf8")).resolves.toBe(
            "inner\n",
        );
        await expect(readFile(join(workspacePath, "aliased.txt"), "utf8")).resolves.toBe(
            "real content\n",
        );
        expect((await lstat(join(workspacePath, "aliased.txt"))).isSymbolicLink()).toBe(false);
    });

    it("skips a path blocked by a file instead of failing", async () => {
        const { projectPath, workspacePath } = await createRoots();
        await mkdir(join(projectPath, "occupied"));
        await Promise.all([
            // The source parent is a file, so the source is unreachable rather than missing.
            writeFile(join(projectPath, "blocking.txt"), "file\n"),
            // The source exists, but the workspace has a file where the destination needs a
            // directory to be created inside.
            writeFile(join(projectPath, "occupied", "child"), "source\n"),
            writeFile(join(workspacePath, "occupied"), "workspace file\n"),
        ]);

        await syncWorkspaceFiles({
            paths: ["blocking.txt/child", "occupied/child"],
            projectPath,
            workspacePath,
        });

        await expect(lstat(join(workspacePath, "blocking.txt"))).rejects.toThrow();
        await expect(readFile(join(workspacePath, "occupied"), "utf8")).resolves.toBe(
            "workspace file\n",
        );
    });

    it("rejects a path that escapes the project", async () => {
        const { projectPath, workspacePath } = await createRoots();

        await expect(
            syncWorkspaceFiles({ paths: ["../escape"], projectPath, workspacePath }),
        ).rejects.toThrow('Workspace sync path "../escape" must stay inside the project.');
    });

    it("skips a destination whose ancestor symlinks out of the workspace", async () => {
        const { projectPath, workspacePath } = await createRoots();
        const outside = join(dirname(workspacePath), "outside");
        await mkdir(join(projectPath, "nested"));
        await mkdir(outside);
        await Promise.all([
            writeFile(join(projectPath, "nested", "file.txt"), "content\n"),
            writeFile(join(outside, "precious.txt"), "untouched\n"),
        ]);
        // The workspace redirected the destination's parent outside itself.
        await symlink(outside, join(workspacePath, "nested"));

        await syncWorkspaceFiles({ paths: ["nested/file.txt"], projectPath, workspacePath });

        await expect(readFile(join(outside, "precious.txt"), "utf8")).resolves.toBe("untouched\n");
        await expect(lstat(join(outside, "file.txt"))).rejects.toThrow();
    });

    it("never recreates a workspace folder that no longer exists", async () => {
        const { projectPath, workspacePath } = await createRoots();
        await writeFile(join(projectPath, ".env"), "KEY=value\n");
        await rm(workspacePath, { recursive: true });

        await syncWorkspaceFiles({ paths: [".env"], projectPath, workspacePath });

        await expect(lstat(workspacePath)).rejects.toThrow();
    });
});
