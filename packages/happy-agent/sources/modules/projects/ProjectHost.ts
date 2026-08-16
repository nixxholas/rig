import { access, realpath, stat } from "node:fs/promises";

import { Type, type Static } from "@sinclair/typebox";

import type { GitCommandRunner } from "../git/GitCommandRunner.js";

export type { GitCommandResult, GitCommandRunner } from "../git/GitCommandRunner.js";

/**
 * Who a person is when Git records their work.
 *
 * Cloning a remote repository on someone's behalf needs their name and address for the commits
 * that follow, and `parentInstanceId` to confirm the profile still belongs to the machine that
 * asked. The agent does not own profiles, so the service asks for one by identifier and refuses
 * to clone when the answer does not come back.
 */
export const projectCreatorProfileSchema = Type.Object(
    {
        email: Type.String({ minLength: 1, maxLength: 320 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        parentInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type ProjectCreatorProfile = Static<typeof projectCreatorProfileSchema>;

/**
 * Resolves a path a person typed to the real folder behind it.
 *
 * Symbolic links are followed here rather than later so two names for one folder cannot become
 * two projects, and a path that is not a directory is refused with a sentence rather than an
 * `ENOTDIR`.
 */
export async function canonicalProjectDirectory(path: string): Promise<string> {
    const canonical = await realpath(path);
    const information = await stat(canonical);
    if (!information.isDirectory()) {
        throw new Error("The project path must be a directory.");
    }
    await access(canonical);
    return canonical;
}

/**
 * Confirms a folder is the root of a working tree, not a subfolder of one.
 *
 * A project registered at `packages/thing` inside a repository would put its workspaces on
 * branches of a repository it does not own, so the check is up front and the answer is the
 * canonical top level.
 */
export async function assertGitTopLevel(git: GitCommandRunner, path: string): Promise<string> {
    const result = await git.run(path, ["rev-parse", "--show-toplevel"], {
        maxOutputBytes: 16 * 1024,
    });
    if (result.code !== 0) {
        throw new Error("The project folder is not a Git repository.");
    }
    const topLevel = await realpath(result.stdout.trim());
    if (topLevel !== path) {
        throw new Error("The project path must be the top level of a Git repository.");
    }
    return topLevel;
}
