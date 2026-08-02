import { access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface PluginNodeRuntime {
    argv: readonly string[];
    executable: string;
}

export interface PluginSdkRuntimePaths {
    dockerBootstrapPath: string;
    loaderPath: string;
    sdkModuleDirectory: string;
    typeboxModuleDirectory: string;
}

export async function createPluginNodeRuntime(options: {
    entryPath: string;
}): Promise<PluginNodeRuntime> {
    const { loaderPath, sdkModuleDirectory } = await resolvePluginSdkRuntimePaths();
    const loaderUrl = pathToFileURL(loaderPath);
    loaderUrl.searchParams.set("sdk", sdkModuleDirectory);
    return {
        argv: [process.execPath, "--import", loaderUrl.href, options.entryPath],
        executable: process.execPath,
    };
}

export async function resolvePluginSdkRuntimePaths(): Promise<PluginSdkRuntimePaths> {
    return {
        dockerBootstrapPath: await resolveDockerBootstrapPath(),
        loaderPath: await resolveLoaderPath(),
        sdkModuleDirectory: await resolveShippedSdkModuleDirectory(),
        typeboxModuleDirectory: await resolveTypeboxModuleDirectory(),
    };
}

async function resolveDockerBootstrapPath(): Promise<string> {
    const directory = dirname(fileURLToPath(import.meta.url));
    const shipped = join(directory, "plugin-docker-bootstrap.js");
    try {
        await access(shipped);
        return shipped;
    } catch {
        return join(directory, "pluginDockerBootstrap.ts");
    }
}

async function resolveTypeboxModuleDirectory(): Promise<string> {
    const entry = require.resolve("@sinclair/typebox");
    return realpath(join(dirname(entry), "..", ".."));
}

async function resolveLoaderPath(): Promise<string> {
    const directory = dirname(fileURLToPath(import.meta.url));
    const shipped = join(directory, "plugin-sdk-loader.js");
    try {
        await access(shipped);
        return shipped;
    } catch {
        return join(directory, "happyPluginsLoader.ts");
    }
}

async function resolveShippedSdkModuleDirectory(): Promise<string> {
    const shipped = join(dirname(fileURLToPath(import.meta.url)), "plugin-sdk");
    try {
        await access(join(shipped, "index.js"));
        return shipped;
    } catch {
        return dirname(require.resolve("happy-plugins"));
    }
}
