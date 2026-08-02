import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface PluginNodeRuntime {
    argv: readonly string[];
    executable: string;
}

export async function createPluginNodeRuntime(options: {
    entryPath: string;
}): Promise<PluginNodeRuntime> {
    const loaderPath = await resolveLoaderPath();
    const sdkModuleDirectory = await resolveShippedSdkModuleDirectory();
    const loaderUrl = pathToFileURL(loaderPath);
    loaderUrl.searchParams.set("sdk", sdkModuleDirectory);
    return {
        argv: [process.execPath, "--import", loaderUrl.href, options.entryPath],
        executable: process.execPath,
    };
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
