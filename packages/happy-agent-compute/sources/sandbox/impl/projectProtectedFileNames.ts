import type { ComputeHostPolicy } from "../../ComputeHostPolicy.js";

/** Root project files a restricted command must not create or modify. */
export function projectProtectedFileNames(hostPolicy: ComputeHostPolicy = {}): readonly string[] {
    return [
        ...new Set([
            ...(hostPolicy.protectedProjectFiles ?? []),
            ...(hostPolicy.networkPolicyFiles ?? []),
        ]),
    ];
}

/** Root project files whose contents can grant later commands network access. */
export function projectNetworkPolicyFileNames(
    hostPolicy: ComputeHostPolicy = {},
): readonly string[] {
    return [...new Set(hostPolicy.networkPolicyFiles ?? [])];
}
