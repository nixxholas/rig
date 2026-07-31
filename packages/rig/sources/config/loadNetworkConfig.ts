import { DEFAULT_RIG_CONFIG } from "./defaultConfig.js";
import { mergeConfigValues } from "./mergeConfigValues.js";
import { readConfigFile } from "./readConfigFile.js";
import { readProjectConfigFile } from "./readProjectConfigFile.js";
import { resolveConfigPaths } from "./resolveConfigPaths.js";
import type { ConfigNetwork, LoadConfigOptions, PartialRigConfig } from "./types.js";
import { withoutProjectMachineSettings } from "./withoutProjectMachineSettings.js";

export async function loadNetworkConfig(
    options: LoadConfigOptions = {},
): Promise<ConfigNetwork | undefined> {
    const paths = resolveConfigPaths(options);
    const [globalSource, localSource] = await Promise.all([
        readConfigFile(paths.global),
        readProjectConfigFile(paths.local),
    ]);
    return mergeNetworkConfig(globalSource.values, localSource.values);
}

export async function loadNetworkConfigForProject(
    project: PartialRigConfig,
    options: Omit<LoadConfigOptions, "cwd"> = {},
): Promise<ConfigNetwork | undefined> {
    const paths = resolveConfigPaths(options);
    const globalSource = await readConfigFile(paths.global);
    return mergeNetworkConfig(globalSource.values, project);
}

function mergeNetworkConfig(
    global: PartialRigConfig,
    project: PartialRigConfig,
): ConfigNetwork | undefined {
    const network = mergeConfigValues(
        DEFAULT_RIG_CONFIG,
        global,
        withoutProjectMachineSettings(project),
    ).network;
    if (network === undefined) return undefined;
    const deniedDomains = [
        ...(global.network?.deniedDomains ?? []),
        ...(project.network?.deniedDomains ?? []),
    ];
    return deniedDomains.length === 0
        ? network
        : { ...network, deniedDomains: [...new Set(deniedDomains)] };
}
