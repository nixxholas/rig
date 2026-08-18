import type { Context } from "@steve.kite/stdlib";

import type { Compute, ComputeModule } from "../../compute/index.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";

/**
 * Settle where generated media will land, before Gemini is asked to make it.
 *
 * A generation is billed work, so the file that would be overwritten is checked first: refusing
 * afterwards would mean paying for an image nobody can keep. A path that does not exist yet is
 * nobody's work to lose.
 */
export async function prepareGeneratedMediaOutputPath(
    computeModule: ComputeModule,
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    path: string,
): Promise<string> {
    const resolvedPath = computeModule.resolvePath(compute, path);
    await reads.assertRead(ctx, compute.fs, computeModule.permissionsForContext(ctx), resolvedPath);
    return resolvedPath;
}
