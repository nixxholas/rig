import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePluginWorkspaceFilePath } from "../sources/internal.js";
import { toPluginWorkspaceOperationError } from "../sources/toPluginWorkspaceOperationError.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("plugin workspace operations", () => {
    it("validates symlinks canonically while returning the unresolved workspace path", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "happy-plugin-workspace-operations-"));
        temporaryDirectories.push(workspace);
        await mkdir(join(workspace, "target"));
        await symlink(join(workspace, "target"), join(workspace, "link"));

        await expect(resolvePluginWorkspaceFilePath(workspace, "link/file.txt")).resolves.toBe(
            join(workspace, "link/file.txt"),
        );
    });

    it.each([
        ["EACCES", "The requested workspace file path is not accessible."],
        ["EROFS", "The workspace file system is read-only."],
        ["EEXIST", "The workspace file could not be written because a path entry already exists."],
        [
            "ENOTDIR",
            "The workspace file could not be written because part of its path is not a directory.",
        ],
    ])("sanitizes expected %s write failures", (code, message) => {
        const rawError = Object.assign(new Error(`raw path: ${process.cwd()}`), { code });

        expect(toPluginWorkspaceOperationError(rawError, "write")).toMatchObject({
            message,
            status: 400,
        });
    });

    it("sanitizes unexpected workspace failures without exposing their raw message", () => {
        const rawError = Object.assign(new Error(`raw path: ${process.cwd()}`), {
            code: "ENAMETOOLONG",
        });
        const mapped = toPluginWorkspaceOperationError(rawError, "read");

        expect(mapped).toMatchObject({
            message: "The workspace file could not be read.",
            status: 400,
        });
        expect(mapped.message).not.toContain(process.cwd());
        expect(mapped.cause).toBe(rawError);
    });
});
