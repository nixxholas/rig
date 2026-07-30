import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseConfigToml } from "../../config/parseConfigToml.js";
import type { ManagedNetworkPolicy } from "./ManagedNetworkPolicy.js";

export async function loadProjectManagedNetworkPolicy(
    cwd: string,
): Promise<ManagedNetworkPolicy | undefined> {
    let source: string;
    try {
        source = await readFile(join(cwd, "rig.toml"), "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
    const network = parseConfigToml(source).network;
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

export function mergeManagedNetworkPolicies(
    ...policies: readonly (ManagedNetworkPolicy | undefined)[]
): ManagedNetworkPolicy | undefined {
    const present = policies.filter(
        (policy): policy is ManagedNetworkPolicy => policy !== undefined,
    );
    if (present.length === 0) return undefined;
    return {
        allowedDomains: present.flatMap((policy) => policy.allowedDomains ?? []),
        allowedLoopbackPorts: [
            ...new Set(present.flatMap((policy) => policy.allowedLoopbackPorts ?? [])),
        ],
        deniedDomains: present.flatMap((policy) => policy.deniedDomains ?? []),
    };
}
