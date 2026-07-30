import type { ManagedNetworkBlockedRequest } from "./ManagedNetworkPolicy.js";

export function formatManagedNetworkDenial(request: ManagedNetworkBlockedRequest): string {
    const reason =
        request.reason === "not_allowed"
            ? "the destination is not in the allowlist"
            : request.reason === "denied"
              ? "the destination is in the denylist"
              : request.reason === "dns_resolution_failed"
                ? "its DNS address could not be resolved safely within two seconds"
                : "the destination resolves to a local or private address";
    return (
        `Network access to ${request.host}:${String(request.port)} was denied by Rig's sandbox ` +
        `network policy because ${reason}. Rig manages the proxy variables for this sandbox; ` +
        "removing them cannot grant direct network access. The user must update rig.toml or " +
        "~/.rig/config.toml to allow this destination.\n"
    );
}
