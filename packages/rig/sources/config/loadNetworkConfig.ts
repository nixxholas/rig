import { DEFAULT_RIG_CONFIG } from "./defaultConfig.js";
import { mergeConfigValues } from "./mergeConfigValues.js";
import { readConfigFile } from "./readConfigFile.js";
import { resolveConfigPaths } from "./resolveConfigPaths.js";
import type { ConfigNetwork, LoadConfigOptions, PartialRigConfig } from "./types.js";
import { withoutProjectMachineSettings } from "./withoutProjectMachineSettings.js";

export async function loadNetworkConfig(
    options: LoadConfigOptions = {},
): Promise<ConfigNetwork | undefined> {
    const paths = resolveConfigPaths(options);
    const [globalSource, localSource, runtimeSource] = await Promise.all([
        readConfigFile(paths.global),
        readConfigFile(paths.local),
        readConfigFile(paths.runtime),
    ]);
    return mergeNetworkConfig(globalSource.values, localSource.values, runtimeSource.values);
}

export async function loadNetworkConfigForProject(
    project: PartialRigConfig,
    options: Omit<LoadConfigOptions, "cwd"> = {},
): Promise<ConfigNetwork | undefined> {
    const paths = resolveConfigPaths(options);
    const [globalSource, runtimeSource] = await Promise.all([
        readConfigFile(paths.global),
        readConfigFile(paths.runtime),
    ]);
    return mergeNetworkConfig(globalSource.values, project, runtimeSource.values);
}

function mergeNetworkConfig(
    global: PartialRigConfig,
    project: PartialRigConfig,
    runtime: PartialRigConfig,
): ConfigNetwork | undefined {
    return mergeConfigValues(
        DEFAULT_RIG_CONFIG,
        global,
        withoutProjectMachineSettings(project),
        runtime,
    ).network;
}
