import type { ComputeHostPolicy } from "../../ComputeHostPolicy.js";
import type { ManagedNetworkBlockedRequest } from "../ManagedNetworkPolicy.js";

export function formatManagedNetworkDenial(
    request: ManagedNetworkBlockedRequest,
    hostPolicy: ComputeHostPolicy = {},
): string {
    const reason =
        request.reason === "not_allowed"
            ? "the destination is not in the allowlist"
            : request.reason === "denied"
              ? "the destination is in the denylist"
              : request.reason === "dns_resolution_failed"
                ? "its DNS address could not be resolved safely within two seconds"
                : "the destination resolves to a local or private address";
    const policyFiles = hostPolicy.networkPolicyFiles ?? [];
    const policyInstruction =
        policyFiles.length === 0
            ? "The user must update the network policy to allow this destination."
            : `The user must update ${formatPolicyFileNames(policyFiles)} in the project root to allow this destination.`;
    return (
        `Network access to ${request.host}:${String(request.port)} was denied by the sandbox ` +
        `network policy because ${reason}. The proxy variables for this sandbox are managed; ` +
        `removing them cannot grant direct network access. ${policyInstruction}\n`
    );
}

function formatPolicyFileNames(paths: readonly string[]): string {
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 1) return `'${uniquePaths[0]}'`;
    return uniquePaths.map((path) => `'${path}'`).join(" or ");
}
