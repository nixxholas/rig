import type Dockerode from "dockerode";

import type { ManagedNetworkPolicy } from "../agent/context/ManagedNetworkPolicy.js";
import { parseConfigToml } from "../config/parseConfigToml.js";
import { runDockerExec } from "./runDockerExec.js";

export async function loadDockerProjectManagedNetworkPolicy(
    container: Dockerode.Container,
    cwd: string,
): Promise<ManagedNetworkPolicy | undefined> {
    const result = await runDockerExec(container, [
        "/bin/sh",
        "-c",
        'if [ -f "$1/rig.toml" ]; then cat "$1/rig.toml"; else exit 44; fi',
        "rig",
        cwd,
    ]);
    if (result.exitCode === 44) return undefined;
    if (result.exitCode !== 0) throw new Error("Could not read the Docker project's rig.toml.");
    const network = parseConfigToml(result.stdout.toString("utf8")).network;
    if (network === undefined) return undefined;
    const ports = network.allowedPorts ?? [443];
    return {
        ...(network.allowedDomains === undefined
            ? {}
            : {
                  allowedDomains: network.allowedDomains.map((domain) => ({ domain, ports })),
              }),
        ...(network.allowedLoopbackPorts === undefined
            ? {}
            : { allowedLoopbackPorts: network.allowedLoopbackPorts }),
        ...(network.deniedDomains === undefined
            ? {}
            : { deniedDomains: network.deniedDomains.map((domain) => ({ domain })) }),
    };
}
