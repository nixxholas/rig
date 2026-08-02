import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ignore, { type Ignore } from "ignore";

import { runGitCommand } from "./runGitCommand.js";
import type { GitCommandRunner } from "./types.js";

export type WorkspaceTransferState =
    | { status: "validating" }
    | { commit: string; status: "staging" }
    | { commit: string; status: "applying" }
    | { commit: string; status: "prepared" }
    | { commit: string; status: "committing" }
    | { commit: string; status: "rolling_back" }
    | { commit: string; status: "succeeded" }
    | {
          error: unknown;
          status: "failed";
          target: "not_touched" | "restored" | "restore_failed";
      };

export class WorkspaceTransferTargetRestoreError extends AggregateError {
    readonly originalError: unknown;
    readonly restoreError: unknown;

    constructor(originalError: unknown, restoreError: unknown, workspaceName?: string) {
        const originalMessage = sentenceFragment(errorMessage(originalError));
        const restoreMessage = sentenceFragment(errorMessage(restoreError));
        super(
            [originalError, restoreError],
            workspaceName === undefined
                ? `The workspace transfer failed: ${originalMessage}. The target workspace could not be restored: ${restoreMessage}.`
                : `The session transfer failed while updating workspace '${workspaceName}': ${originalMessage}. The workspace could not be restored: ${restoreMessage}. It was marked failed and needs repair.`,
        );
        this.name = "WorkspaceTransferTargetRestoreError";
        this.originalError = originalError;
        this.restoreError = restoreError;
    }
}

export interface PreparedWorkspaceTransfer {
    readonly commit: string;
    readonly state: WorkspaceTransferState;
    commitTransfer(): Promise<void>;
    rollback(error?: unknown): Promise<void>;
}

export async function prepareWorkspaceTransfer(options: {
    beforeApply?: () => void | Promise<void>;
    git?: GitCommandRunner;
    sourcePath: string;
    targetPath: string;
}): Promise<PreparedWorkspaceTransfer> {
    const git = options.git ?? runGitCommand;
    let state: WorkspaceTransferState = { status: "validating" };
    await assertGitWorkspace(git, options.sourcePath);
    await assertGitWorkspace(git, options.targetPath);
    const commit = await git(options.sourcePath, ["rev-parse", "--verify", "HEAD"]);
    const targetCommit = await git(options.targetPath, ["rev-parse", "--verify", "HEAD"]);
    state = { commit, status: "staging" };

    const stagingRoot = await mkdtemp(join(tmpdir(), "rig-session-transfer-"));
    const payloadPath = join(stagingRoot, "payload");
    let targetTouched = false;
    const restoreTarget = async (): Promise<void> => {
        await git(options.targetPath, ["reset", "--hard", targetCommit]);
        await git(options.targetPath, ["clean", "-d", "-f", "-f", "-x"]);
    };

    try {
        await mkdir(payloadPath);
        const exclusions = await readHappyIgnore(options.sourcePath);
        await copyTree(options.sourcePath, payloadPath, {
            exclude: (path, directory) => isOverlayExcluded(exclusions, path, directory),
        });

        await options.beforeApply?.();
        state = { commit, status: "applying" };
        targetTouched = true;
        await git(options.targetPath, ["reset", "--hard", commit]);
        await git(options.targetPath, ["clean", "-d", "-f", "-f", "-x"]);
        const tracked = splitNull(
            await git(options.sourcePath, ["ls-tree", "-r", "-z", "--name-only", commit]),
        );
        for (const path of tracked) {
            if (await pathExists(join(options.sourcePath, path))) continue;
            await rm(join(options.targetPath, path), { force: true, recursive: true });
        }
        await copyTree(payloadPath, options.targetPath);
        state = { commit, status: "prepared" };
    } catch (originalError) {
        let failure: unknown = originalError;
        let target: "not_touched" | "restored" | "restore_failed" = "not_touched";
        if (targetTouched) {
            try {
                await restoreTarget();
                target = "restored";
            } catch (restoreError) {
                failure = new WorkspaceTransferTargetRestoreError(originalError, restoreError);
                target = "restore_failed";
            }
        }
        state = { error: failure, status: "failed", target };
        await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
        throw failure;
    }

    return {
        commit,
        get state() {
            return state;
        },
        async commitTransfer() {
            if (state.status === "succeeded") return;
            if (state.status === "failed") {
                throw new Error("A failed workspace transfer cannot be committed.");
            }
            if (state.status !== "prepared") {
                throw new Error(`The workspace transfer cannot commit from ${state.status}.`);
            }
            state = { commit, status: "committing" };
            await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
            state = { commit, status: "succeeded" };
        },
        async rollback(originalError = new Error("The workspace transfer was rolled back.")) {
            if (state.status === "failed" || state.status === "succeeded") return;
            if (state.status !== "prepared") {
                throw new Error(`The workspace transfer cannot roll back from ${state.status}.`);
            }
            state = { commit, status: "rolling_back" };
            try {
                await restoreTarget();
            } catch (restoreError) {
                const failure = new WorkspaceTransferTargetRestoreError(
                    originalError,
                    restoreError,
                );
                state = {
                    error: failure,
                    status: "failed",
                    target: "restore_failed",
                };
                await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
                throw failure;
            }
            await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
            state = { error: originalError, status: "failed", target: "restored" };
        },
    };
}

async function assertGitWorkspace(git: GitCommandRunner, path: string): Promise<void> {
    try {
        if ((await git(path, ["rev-parse", "--is-inside-work-tree"])) === "true") return;
    } catch {
        // The human-readable transfer requirement below replaces raw Git stderr.
    }
    throw new Error("Session transfer currently requires Git workspaces.");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sentenceFragment(value: string): string {
    return value.replace(/[.!?]+$/u, "");
}

async function readHappyIgnore(root: string): Promise<Ignore | undefined> {
    const contents = await readFile(join(root, ".happyignore"), "utf8").catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
    });
    return contents === undefined ? undefined : ignore().add(contents);
}

function isOverlayExcluded(
    exclusions: Ignore | undefined,
    path: string,
    directory: boolean,
): boolean {
    if (path === ".context" || path.startsWith(".context/")) return false;
    if (path === ".git" || path.startsWith(".git/")) return true;
    return exclusions?.ignores(directory ? `${path}/` : path) === true;
}

async function copyTree(
    source: string,
    target: string,
    options: { exclude?: (path: string, directory: boolean) => boolean } = {},
    relativePath = "",
): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
        const path = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        const directory = entry.isDirectory();
        if (options.exclude?.(path, directory) === true) continue;
        const sourceEntry = join(source, entry.name);
        const targetEntry = join(target, entry.name);
        if (directory) {
            const targetDetails = await lstat(targetEntry).catch((error: unknown) => {
                if (isMissing(error)) return undefined;
                throw error;
            });
            if (targetDetails !== undefined && !targetDetails.isDirectory()) {
                await rm(targetEntry, { force: true, recursive: true });
            }
            await mkdir(targetEntry, { recursive: true });
            await copyTree(sourceEntry, targetEntry, options, path);
            continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const targetDetails = await lstat(targetEntry).catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        });
        if (targetDetails?.isDirectory() === true) {
            await rm(targetEntry, { force: true, recursive: true });
        }
        await cp(sourceEntry, targetEntry, {
            force: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
        });
    }
}

async function pathExists(path: string): Promise<boolean> {
    return lstat(path)
        .then(() => true)
        .catch((error: unknown) => {
            if (isMissing(error)) return false;
            throw error;
        });
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

function splitNull(output: string): readonly string[] {
    return output.split("\0").filter((path) => path.length > 0);
}
