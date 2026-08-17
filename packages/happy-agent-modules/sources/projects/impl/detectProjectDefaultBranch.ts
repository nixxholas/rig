import { computePermissions } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { HostCompute } from "../../compute/ComputeModule.js";
import { readProjectGit } from "./runProjectGit.js";

/**
 * The trunk a project's workspaces should be cut from.
 *
 * What the remote itself points `HEAD` at is the real answer. Failing that, a `main` or `master`
 * that exists locally or on the remote is what almost every repository means by its trunk, and
 * the branch currently checked out is the last honest fallback.
 */
export async function detectProjectDefaultBranch(
    ctx: Context,
    compute: HostCompute,
    path: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    const permissions = computePermissions("read_only");
    const read = async (args: readonly string[]): Promise<string | undefined> =>
        await readProjectGit(ctx, compute, path, args, {
            permissions,
            ...(signal === undefined ? {} : { signal }),
        });

    const originHead = await read(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (originHead !== undefined && originHead.startsWith("origin/")) {
        return originHead.slice("origin/".length);
    }
    for (const candidate of ["main", "master"]) {
        const known =
            (await read(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) ??
            (await read(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]));
        if (known !== undefined) return candidate;
    }
    return await read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
}
