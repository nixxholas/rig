import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    prepareWorkspaceTransfer,
    WorkspaceTransferTargetRestoreError,
} from "./prepareWorkspaceTransfer.js";
import type { GitCommandRunner } from "./types.js";

describe("prepareWorkspaceTransfer", () => {
    it("keeps the original failure primary and makes a restore failure terminal", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-transfer-state-"));
        const sourcePath = join(root, "source");
        const targetPath = join(root, "target");
        await Promise.all([mkdir(sourcePath), mkdir(targetPath)]);
        await writeFile(join(sourcePath, "work.txt"), "source\n");
        let failRestore = false;
        const restoreError = new Error("Target restore failed.");
        const git: GitCommandRunner = async (cwd, args) => {
            if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
                return "true";
            }
            if (args[0] === "rev-parse") {
                return cwd === sourcePath ? "source-commit" : "target-commit";
            }
            if (
                failRestore &&
                cwd === targetPath &&
                args[0] === "reset" &&
                args[2] === "target-commit"
            ) {
                throw restoreError;
            }
            return "";
        };

        try {
            const prepared = await prepareWorkspaceTransfer({
                git,
                sourcePath,
                targetPath,
            });
            expect(prepared.state).toEqual({
                commit: "source-commit",
                status: "prepared",
            });
            const originalError = new Error("Session persistence failed.");
            failRestore = true;

            let failure: unknown;
            try {
                await prepared.rollback(originalError);
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(WorkspaceTransferTargetRestoreError);
            expect(failure).toMatchObject({
                errors: [originalError, restoreError],
                originalError,
                restoreError,
            });
            expect(prepared.state).toMatchObject({
                error: failure,
                status: "failed",
                target: "restore_failed",
            });
            await expect(prepared.commitTransfer()).rejects.toThrow(
                "A failed workspace transfer cannot be committed.",
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it("rejects non-Git workspaces with a human-readable requirement", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-transfer-non-git-"));
        const sourcePath = join(root, "source");
        const targetPath = join(root, "target");
        await Promise.all([mkdir(sourcePath), mkdir(targetPath)]);
        const git: GitCommandRunner = async () => {
            throw new Error("fatal: not a git repository");
        };

        try {
            await expect(prepareWorkspaceTransfer({ git, sourcePath, targetPath })).rejects.toThrow(
                "Session transfer currently requires Git workspaces",
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
