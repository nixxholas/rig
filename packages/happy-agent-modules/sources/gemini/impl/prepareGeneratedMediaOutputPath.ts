import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../../compute/Compute.js";
import { computePermissionsForContext } from "../../compute/impl/computePermissionsForContext.js";
import type { FileReadLog } from "../../compute/impl/FileReadLog.js";
import { resolveComputePath } from "../../compute/impl/resolveComputePath.js";

/**
 * Settle where generated media will land, before Gemini is asked to make it.
 *
 * A generation is billed work, so the file that would be overwritten is checked first: refusing
 * afterwards would mean paying for an image nobody can keep. A path that does not exist yet is
 * nobody's work to lose.
 */
export async function prepareGeneratedMediaOutputPath(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    path: string,
): Promise<string> {
    const resolvedPath = resolveComputePath(path, compute.cwd, compute.fs.home);
    await reads.assertRead(ctx, compute.fs, computePermissionsForContext(ctx), resolvedPath);
    return resolvedPath;
}
