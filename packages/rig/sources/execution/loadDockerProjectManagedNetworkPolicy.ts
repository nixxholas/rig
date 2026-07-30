import type Dockerode from "dockerode";

import type { ManagedNetworkPolicy } from "../agent/context/ManagedNetworkPolicy.js";
import { toManagedNetworkPolicy } from "../agent/context/loadProjectManagedNetworkPolicy.js";
import { loadNetworkConfigForProject } from "../config/loadNetworkConfig.js";
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
    if (result.exitCode !== 0 && result.exitCode !== 44)
        throw new Error("Could not read the Docker project's rig.toml.");
    const project = result.exitCode === 44 ? {} : parseConfigToml(result.stdout.toString("utf8"));
    return toManagedNetworkPolicy(await loadNetworkConfigForProject(project));
}
