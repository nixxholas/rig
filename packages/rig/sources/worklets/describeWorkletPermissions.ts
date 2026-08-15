import type { WorkletPermissions } from "../protocol/WorkletProtocol.js";

/**
 * Describes the persistent authority a worklet process receives in permission-review language.
 *
 * Installation and live tool calls use this same text so the two review boundaries cannot drift.
 */
export function describeWorkletPermissions(permissions: WorkletPermissions): string {
    return `${describeDisk(permissions.disk)} ${describeNetwork(permissions.network)}`;
}

function describeDisk(_permissions: WorkletPermissions["disk"]): string {
    return "Disk: it may write only its own persistent Data folder and private temporary files.";
}

function describeNetwork(permissions: WorkletPermissions["network"]): string {
    if (permissions === "none") return "Network: it has no IP network access.";
    return `Network: through Rig's managed proxy it may reach exactly these declared hosts: ${permissions.hosts
        .map((host) => JSON.stringify(host))
        .join(", ")}.`;
}
