import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GitCommandRunner } from "../../sources/modules/git/GitCommandRunner.js";
import { detectGitDefaultBranch } from "../../sources/modules/git/detectGitDefaultBranch.js";
import { parseHostingRepository } from "../../sources/modules/git/parseHostingRepository.js";
import { probeGitRepository } from "../../sources/modules/git/probeGitRepository.js";
import { remoteProjectName } from "../../sources/modules/git/remoteProjectName.js";
import { resolveWorkspaceBase } from "../../sources/modules/git/resolveWorkspaceBase.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    git,
    gitRunner,
    setOriginMain,
} from "./helpers.js";

afterEach(cleanupRoots);

describe("repository facts and workspace base", () => {
    it("probes roots, rejects nested folders, and detects the default branch", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "README.md", "fixture\n");
        const nested = join(repository, "nested");
        await mkdir(nested);

        expect(await detectGitDefaultBranch(gitRunner, repository)).toBe("main");
        expect(await probeGitRepository({ git: gitRunner, path: repository })).toMatchObject({
            facts: { branch: "main", head },
            presence: "present",
            worktreeSupport: "supported",
        });
        expect(await probeGitRepository({ git: gitRunner, path: nested })).toMatchObject({
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is inside a Git repository but is not its root.",
        });
    });

    it("forks origin/main rather than a moved local main", async () => {
        const repository = await createRepository();
        const remoteHead = await commitFile(repository, "base.txt", "base\n");
        await setOriginMain(repository, remoteHead);
        await commitFile(repository, "local.txt", "local\n");

        await expect(
            resolveWorkspaceBase({
                defaultBranch: "main",
                git: gitRunner,
                projectPath: repository,
            }),
        ).resolves.toEqual({ commit: remoteHead, ref: "origin/main" });
    });

    it("bounds fetch and threads the caller's abort signal through base resolution", async () => {
        const repository = await createRepository();
        const remoteHead = await commitFile(repository, "base.txt", "base\n");
        await setOriginMain(repository, remoteHead);
        await git(repository, ["remote", "add", "origin", "https://example.test/repository.git"]);
        const controller = new AbortController();
        const calls: Array<{
            args: readonly string[];
            signal: AbortSignal | undefined;
            timeoutMs: number | undefined;
        }> = [];
        const runner: GitCommandRunner = {
            async run(cwd, args, options) {
                calls.push({
                    args,
                    signal: options?.signal,
                    timeoutMs: options?.timeoutMs,
                });
                if (args[0] === "fetch") {
                    return { code: 1, stderr: "offline", stdout: "" };
                }
                return await gitRunner.run(cwd, args, options);
            },
        };

        await expect(
            resolveWorkspaceBase({
                defaultBranch: "main",
                git: runner,
                projectPath: repository,
                signal: controller.signal,
            }),
        ).resolves.toEqual({ commit: remoteHead, ref: "origin/main" });
        const fetch = calls.find((call) => call.args[0] === "fetch");
        expect(fetch?.timeoutMs).toBeGreaterThanOrEqual(60_000);
        expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
    });

    it("parses hosting identity without accepting local paths", () => {
        expect(remoteProjectName("git@github.com:slopus/rig.git")).toBe("rig");
        expect(remoteProjectName("/tmp/rig.git")).toBeUndefined();
        expect(parseHostingRepository("git@github.com:slopus/rig.git")).toEqual({
            host: "github.com",
            owner: "slopus",
            repository: "rig",
        });
    });
});
