import { delimiter } from "node:path";

import type { ComputeHostPolicy } from "../../ComputeHostPolicy.js";
import type { ComputePermissionMode } from "../../ComputePermissions.js";
import { findExecutableSearchPaths } from "./findExecutableSearchPaths.js";
import { createShellEnvironment } from "./createShellEnvironment.js";

export async function createToolEnvironment(
    mode: ComputePermissionMode,
    environment: NodeJS.ProcessEnv = process.env,
    options: {
        cwd?: string;
        hostPolicy?: ComputeHostPolicy;
        homeDirectory?: string;
        temporaryDirectory?: string;
    } = {},
): Promise<NodeJS.ProcessEnv> {
    const filtered = createShellEnvironment(environment, options.hostPolicy);
    if (mode === "full_access" || process.platform === "win32") return filtered;
    return {
        ...filtered,
        PATH: (
            await findExecutableSearchPaths({
                cwd: options.cwd ?? process.cwd(),
                environment,
                ...(options.homeDirectory === undefined
                    ? {}
                    : { homeDirectory: options.homeDirectory }),
                ...(options.temporaryDirectory === undefined
                    ? {}
                    : { temporaryDirectory: options.temporaryDirectory }),
            })
        ).join(delimiter),
    };
}
