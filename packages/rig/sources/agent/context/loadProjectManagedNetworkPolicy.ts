import { loadNetworkConfig } from "../../config/loadNetworkConfig.js";
import type { ConfigNetwork } from "../../config/types.js";
import type { ManagedNetworkPolicy } from "./ManagedNetworkPolicy.js";

export async function loadProjectManagedNetworkPolicy(
    cwd: string,
): Promise<ManagedNetworkPolicy | undefined> {
    const network = await loadNetworkConfig({ cwd });
    return toManagedNetworkPolicy(network);
}

export function toManagedNetworkPolicy(
    network: ConfigNetwork | undefined,
): ManagedNetworkPolicy | undefined {
    if (network === undefined) return undefined;
    const ports = network.allowedPorts ?? [443];
    return {
        ...(network.allowedDomains === undefined
            ? {}
            : {
                  allowedDomains: network.allowedDomains.map((domain) => ({ domain, ports })),
              }),
        ...(network.deniedDomains === undefined
            ? {}
            : {
                  deniedDomains: network.deniedDomains.map((domain) => ({ domain })),
              }),
        ...(network.allowedLoopbackPorts === undefined
            ? {}
            : { allowedLoopbackPorts: network.allowedLoopbackPorts }),
    };
}
