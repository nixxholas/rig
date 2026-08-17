import { computePermissions } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { HostCompute } from "../../compute/ComputeModule.js";
import { remoteProjectName } from "./remoteProjectName.js";
import { readProjectGit } from "./runProjectGit.js";

/**
 * The remote this folder is really working against.
 *
 * The remote the current branch tracks is the truthful answer, `origin` is the conventional one,
 * and any remote that names a repository is better than none. A repository with no usable remote
 * is an ordinary state, not a failure.
 */
export async function selectProjectRemoteUrl(
    ctx: Context,
    compute: HostCompute,
    cwd: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    const permissions = computePermissions("read_only");
    const read = async (args: readonly string[]): Promise<string | undefined> =>
        await readProjectGit(ctx, compute, cwd, args, {
            permissions,
            ...(signal === undefined ? {} : { signal }),
        });

    const branch = await read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const tracked =
        branch === undefined ? undefined : await read(["config", "--get", `branch.${branch}.remote`]);
    if (tracked !== undefined && tracked !== ".") {
        const url = await read(["config", "--get", `remote.${tracked}.url`]);
        if (url !== undefined) return url;
    }
    const origin = await read(["config", "--get", "remote.origin.url"]);
    if (origin !== undefined) return origin;

    const remotes = (await read(["remote"]))?.split(/\r?\n/gu).map((value) => value.trim()).filter(Boolean);
    for (const remote of remotes ?? []) {
        const url = await read(["config", "--get", `remote.${remote}.url`]);
        if (url !== undefined && remoteProjectName(url) !== undefined) return url;
    }
    return undefined;
}
