import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createMacOsSeatbeltCommand } from "./createMacOsSeatbeltCommand.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

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
        await mkdir(join(cwd, ".git"));

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(await realpath(cwd));
        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(
            await realpath(join(cwd, ".git")),
        );
        expect(definedPaths(result.args, "PROTECTED_WRITE")).not.toContain(join(cwd, ".git"));
    });

    it("allows outbound network only to the managed proxy port", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            mode: "workspace_write",
            networkAllowedLoopbackPorts: [43_123],
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain('(allow network-outbound (remote ip "localhost:43123"))');
        expect(result.args[1]).not.toContain("\n(allow network-outbound)\n");
    });

    it("allows binding any local port without opening external egress", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            mode: "workspace_write",
            networkAllowLocalBinding: true,
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain('(allow network-bind (local ip "*:*"))');
        expect(result.args[1]).toContain('(allow network-inbound (local ip "localhost:*"))');
        expect(result.args[1]).toContain('(allow network-outbound (remote ip "localhost:*"))');
        expect(result.args[1]).not.toContain("\n(allow network-outbound)\n");
    });

    it.runIf(process.platform === "darwin")(
        "allows a normal commit from a linked worktree in Workspace write mode",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-git-worktree-"));
            temporaryDirectories.push(root);
            const repository = join(root, "repository");
            const worktree = join(root, "worktree");
            await execFileAsync("git", ["init", repository]);
            await execFileAsync("git", [
                "-C",
                repository,
                "config",
                "user.email",
                "rig@example.com",
            ]);
            await execFileAsync("git", ["-C", repository, "config", "user.name", "Rig"]);
            await writeFile(join(repository, "tracked.txt"), "initial\n");
            await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
            await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
            await execFileAsync("git", [
                "-C",
                repository,
                "worktree",
                "add",
                "-b",
                "feature",
                worktree,
            ]);
            await writeFile(join(worktree, "tracked.txt"), "changed\n");

            const result = await createMacOsSeatbeltCommand({
                argv: ["git", "commit", "-am", "sandboxed commit"],
                command: "",
                cwd: worktree,
                mode: "workspace_write",
                shell: "/bin/sh",
            });

            await expect(
                execFileAsync(result.command, result.args as string[], { cwd: worktree }),
            ).resolves.toMatchObject({ stderr: expect.any(String), stdout: expect.any(String) });
        },
    );
});

function definedPaths(args: readonly string[], prefix: string): string[] {
    return args
        .filter((argument) => argument.startsWith(`-D${prefix}_`))
        .map((argument) => argument.slice(argument.indexOf("=") + 1));
}
