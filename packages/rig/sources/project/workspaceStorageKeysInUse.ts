import { readdir } from "node:fs/promises";

import type { GitCommandRunner } from "../git/types.js";

export async function workspaceStorageKeysInUse(options: {
    git: GitCommandRunner;
    projectPath: string;
    workspaceRoot: string;
}): Promise<ReadonlySet<string>> {
    const directoryNames = await readdir(options.workspaceRoot).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return [];
        throw error;
    });
    const branchNames = await options.git(options.projectPath, [
        "for-each-ref",
        "--format=%(refname:lstrip=3)",
        "refs/heads/worktree/",
    ]);
    return new Set(
        [...directoryNames, ...branchNames.split("\n")]
            .filter((storageKey) => storageKey.length > 0)
            .map((storageKey) => storageKey.toLocaleLowerCase("en-US")),
    );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
