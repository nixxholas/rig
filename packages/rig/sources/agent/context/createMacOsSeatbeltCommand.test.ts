import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMacOsSeatbeltCommand } from "./createMacOsSeatbeltCommand.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("createMacOsSeatbeltCommand", () => {
    it("keeps the temporary directory writable in Read only mode without exposing the workspace", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-read-only-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "read_only",
            shell: "/bin/sh",
        });

        const writableRoots = definedPaths(result.args, "WRITABLE_ROOT");
        const canonicalTemporaryDirectory = await realpath(tmpdir());
        expect(writableRoots).toContain(canonicalTemporaryDirectory);
        expect(writableRoots).not.toContain(await realpath(cwd));
        expect(result.args[1]).toContain("(allow file-read*)");
    });

    it("makes the workspace writable in Workspace write mode", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-workspace-write-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(await realpath(cwd));
        expect(definedPaths(result.args, "PROTECTED_WRITE")).toContain(join(cwd, ".git"));
    });
});

function definedPaths(args: readonly string[], prefix: string): string[] {
    return args
        .filter((argument) => argument.startsWith(`-D${prefix}_`))
        .map((argument) => argument.slice(argument.indexOf("=") + 1));
}
