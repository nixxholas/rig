import type { PluginLogSnapshot, PluginSummary } from "../../protocol/index.js";
import type { FileSystemContext } from "./FileSystemContext.js";

export interface InstalledPluginSummary {
    description: string;
    directory: string;
    folder: string;
    name: string;
}

export interface UninstalledPluginSummary {
    dataDirectory: string;
    folder: string;
    name: string;
}

/**
 * Managing the plugins installed on this machine.
 *
 * Each change takes effect at once — a plugin starts when it is installed and stops when it is
 * uninstalled — and the daemon announces the new set to every attached client.
 */
export interface PluginContext {
    install(options: {
        fs: FileSystemContext;
        sourceDirectory: string;
    }): Promise<InstalledPluginSummary>;
    list(): Promise<{
        failures: readonly { error: string; folder: string }[];
        plugins: readonly PluginSummary[];
    }>;
    readLog(name: string): Promise<PluginLogSnapshot>;
    uninstall(options: { fs: FileSystemContext; name: string }): Promise<UninstalledPluginSummary>;
}
