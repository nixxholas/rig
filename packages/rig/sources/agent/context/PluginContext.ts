import type {
    EventId,
    InstalledPluginSummary,
    PluginLogSnapshot,
    PluginSummary,
    UninstalledPluginSummary,
} from "../../protocol/index.js";
import type { HappySystemPromptHookInput, HappyTracingEvent } from "happy-plugins";
import type { PluginAppResource } from "../../plugins/PluginAppRegistry.js";
import type {
    GitHubPluginIndex,
    GitHubPluginInstallSource,
    GitHubPluginSource,
} from "../../plugins/githubPluginCatalog.js";
import type { FileSystemContext } from "./FileSystemContext.js";
import type { Skill } from "../skills/Skill.js";
import type { ManagedNetworkInterceptor } from "./ManagedNetworkPolicy.js";

/**
 * Managing the plugins installed on this machine.
 *
 * Each change takes effect at once — a plugin starts when it is installed and stops when it is
 * uninstalled — and the daemon announces the new set to every attached client.
 */
export interface PluginContext {
    /** Internal managed-proxy hook; absent in lightweight test/plugin-tool contexts. */
    network?: ManagedNetworkInterceptor;
    applySystemPrompt?(input: HappySystemPromptHookInput): Promise<string>;
    discoverRepository(
        source: GitHubPluginSource,
        signal?: AbortSignal,
    ): Promise<GitHubPluginIndex>;
    install(options: {
        fs: FileSystemContext;
        signal?: AbortSignal;
        sourceDirectory: string;
    }): Promise<InstalledPluginSummary>;
    installFromGitHub(
        source: GitHubPluginInstallSource,
        options: { fs: FileSystemContext; signal?: AbortSignal },
    ): Promise<InstalledPluginSummary>;
    loadSkills(fs: FileSystemContext): Promise<readonly Skill[]>;
    loadSystemPrompt?(): Promise<string | undefined>;
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
    trace?(event: HappyTracingEvent): void;
    readLog(name: string): Promise<PluginLogSnapshot>;
    uninstall(options: {
        fs: FileSystemContext;
        name: string;
        signal?: AbortSignal;
    }): Promise<UninstalledPluginSummary>;
}
