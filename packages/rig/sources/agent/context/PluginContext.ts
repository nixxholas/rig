import type {
    EventId,
    InstalledPluginSummary,
    PluginLogSnapshot,
    PluginSummary,
    UninstalledPluginSummary,
} from "../../protocol/index.js";
import type { HappySystemPromptHookInput, HappyTracingEvent } from "happy-plugins";
import type { PluginAppResource } from "../../plugins/PluginAppRegistry.js";
import type { PluginIconResource } from "../../plugins/types.js";
import type {
    GitHubPluginCatalog,
    GitHubPluginInstallationSource,
    GitHubPluginSource,
} from "../../plugins/githubPluginCatalog.js";
import type { FileSystemContext } from "./FileSystemContext.js";
import type { Context } from "@steve.kite/stdlib";
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
    applySystemPrompt?(ctx: Context, input: HappySystemPromptHookInput): Promise<string>;
    discoverRepository(
        ctx: Context,
        source: GitHubPluginSource,
        signal?: AbortSignal,
    ): Promise<GitHubPluginCatalog>;
    install(
        ctx: Context,
        options: {
            fs: FileSystemContext;
            requestId?: string;
            signal?: AbortSignal;
            sourceDirectory: string;
        },
    ): Promise<InstalledPluginSummary>;
    installFromGitHub(
        ctx: Context,
        source: GitHubPluginInstallationSource,
        options: { fs: FileSystemContext; requestId?: string; signal?: AbortSignal },
    ): Promise<InstalledPluginSummary>;
    loadSkills(ctx: Context, fs: FileSystemContext): Promise<readonly Skill[]>;
    loadSystemPrompt?(ctx: Context): Promise<string | undefined>;
    list(ctx: Context): Promise<{
        failures: readonly { error: string; folder: string }[];
        plugins: readonly PluginSummary[];
        version: EventId;
    }>;
    callAppTool(
        ctx: Context,
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
    readIcon(
        ctx: Context,
        pluginId: string,
        generation: string,
        signal?: AbortSignal,
    ): Promise<PluginIconResource>;
    storageDelete(
        ctx: Context,
        applicationId: string,
        generation: string,
        key: string,
    ): Promise<void>;
    storageGet(
        ctx: Context,
        applicationId: string,
        generation: string,
        key: string,
    ): Promise<unknown | undefined>;
    storageList(
        ctx: Context,
        applicationId: string,
        generation: string,
    ): Promise<readonly string[]>;
    storageSet(
        ctx: Context,
        applicationId: string,
        generation: string,
        key: string,
        value: unknown,
    ): Promise<void>;
    trace?(event: HappyTracingEvent): void;
    readLog(ctx: Context, name: string): Promise<PluginLogSnapshot>;
    uninstall(
        ctx: Context,
        options: {
            fs: FileSystemContext;
            name: string;
            signal?: AbortSignal;
        },
    ): Promise<UninstalledPluginSummary>;
}
