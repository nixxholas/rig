import type {
    EventId,
    InstalledPluginSummary,
    PluginLogSnapshot,
    PluginSummary,
    UninstalledPluginSummary,
} from "../../protocol/index.js";
import type { PluginAppResource } from "../../plugins/PluginAppRegistry.js";
import type { FileSystemContext } from "./FileSystemContext.js";

/**
 * Managing the plugins installed on this machine.
 *
 * Each change takes effect at once — a plugin starts when it is installed and stops when it is
 * uninstalled — and the daemon announces the new set to every attached client.
 */
export interface PluginContext {
    install(options: {
        fs: FileSystemContext;
        signal?: AbortSignal;
        sourceDirectory: string;
    }): Promise<InstalledPluginSummary>;
    list(): Promise<{
        failures: readonly { error: string; folder: string }[];
        plugins: readonly PluginSummary[];
        version: EventId;
    }>;
    callAppTool(
        applicationId: string,
        generation: string,
        server: string,
        tool: string,
        input: unknown,
        signal?: AbortSignal,
    ): Promise<unknown>;
    readAppResource(
        applicationId: string,
        generation: string,
        resourceUri: string,
    ): PluginAppResource;
    storageDelete(applicationId: string, generation: string, key: string): Promise<void>;
    storageGet(
        applicationId: string,
        generation: string,
        key: string,
    ): Promise<unknown | undefined>;
    storageList(applicationId: string, generation: string): Promise<readonly string[]>;
    storageSet(
        applicationId: string,
        generation: string,
        key: string,
        value: unknown,
    ): Promise<void>;
    readLog(name: string): Promise<PluginLogSnapshot>;
    uninstall(options: {
        fs: FileSystemContext;
        name: string;
        signal?: AbortSignal;
    }): Promise<UninstalledPluginSummary>;
}
