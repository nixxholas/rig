import { basenameComputePath } from "../../compute/impl/resolveComputePath.js";

/**
 * The lowercase extension of a path on the agent's machine, including its dot, or `""` when the
 * name has none. A leading dot names a hidden file rather than an extension, so `.png` has none.
 *
 * `node:path` is deliberately not used: the path belongs to the compute, which may not separate
 * its directories the way the host running Rig does.
 */
export function computePathExtension(path: string): string {
    const name = basenameComputePath(path);
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
