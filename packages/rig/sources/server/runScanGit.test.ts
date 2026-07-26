import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runScanGit } from "./runScanGit.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const sandboxed = process.platform === "darwin" || process.platform === "linux";

afterEach(async () => {
    await Promise.allSettled(
        roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
});

describe("runScanGit", () => {
    it("reads a repository without writing to it", async () => {
        const repository = await createRepository();
        await writeFile(join(repository, "a.txt"), "one\n");
        await git(repository, ["add", "--all"]);
        await git(repository, ["commit", "--quiet", "--message", "initial"]);

        const result = await runScanGit({
            args: ["status", "--porcelain=v2", "-z", "--branch"],
            cwd: repository,
        });

        expect(result.truncated).toBe(false);
        expect(result.stdout).toContain("# branch.head main");
    });

    it.runIf(sandboxed)(
        "does not let a repository-configured hook run against the daemon",
        async () => {
            const repository = await createRepository();
            await writeFile(join(repository, "a.txt"), "one\n");
            await git(repository, ["add", "--all"]);
            await git(repository, ["commit", "--quiet", "--message", "initial"]);
            const evidence = join(repository, "executed.txt");
            const payload = join(repository, "payload.sh");
            await writeFile(payload, `#!/bin/sh\necho ran > ${JSON.stringify(evidence)}\n`);
            await chmod(payload, 0o755);
            // The sandbox keeps .git writable so agents can commit, which is exactly why a scan
            // must not honour what an agent can write there.
            await git(repository, ["config", "core.fsmonitor", payload]);

            await runScanGit({
                args: ["status", "--porcelain=v2", "-z", "--branch"],
                cwd: repository,
            });

            await expect(access(evidence)).rejects.toThrow();
        },
    );

    it.runIf(sandboxed)(
        "does not run textconv or external diff drivers when producing patch text",
        async () => {
            const repository = await createRepository();
            await writeFile(join(repository, "a.txt"), "one\n");
            await writeFile(join(repository, ".gitattributes"), "a.txt diff=custom\n");
            await git(repository, ["add", "--all"]);
            await git(repository, ["commit", "--quiet", "--message", "initial"]);
            await writeFile(join(repository, "a.txt"), "one\ntwo\n");
            const evidence = join(repository, "external.txt");
            const payload = join(repository, "payload.sh");
            await writeFile(payload, `#!/bin/sh\necho ran >> ${JSON.stringify(evidence)}\n`);
            await chmod(payload, 0o755);
            await git(repository, ["config", "diff.custom.textconv", payload]);
            await git(repository, ["config", "diff.external", payload]);

            // Patch text, not the scan diff: this is the form that actually resolves drivers, so a
            // scan-only assertion here would pass whether or not the flags were applied.
            await runScanGit({
                args: ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "a.txt"],
                cwd: repository,
            });

            await expect(access(evidence)).rejects.toThrow();
        },
    );

    it("reports truncation instead of failing when output exceeds the scan limit", async () => {
        const repository = await createRepository();
        await mkdir(join(repository, "many"));
        await Promise.all(
            Array.from({ length: 400 }, (_unused, index) =>
                writeFile(join(repository, "many", `file-${String(index)}.txt`), "x\n"),
            ),
        );

        // A one-byte ceiling makes the bound observable without generating megabytes of fixture.
        const result = await runScanGit({
            args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
            cwd: repository,
            maximumBytes: 1,
        });

        expect(result.truncated).toBe(true);
    });

    it("stops a scan when its abort signal fires", async () => {
        const repository = await createRepository();
        const controller = new AbortController();
        controller.abort();

        await expect(
            runScanGit({
                args: ["status", "--porcelain=v2", "-z"],
                cwd: repository,
                signal: controller.signal,
            }),
        ).rejects.toThrow();
    });
});

async function createRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-scan-git-"));
    roots.push(root);
    const repository = join(root, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 20_000,
    });
    return result.stdout.trim();
}
