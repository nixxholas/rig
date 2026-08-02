import { join } from "node:path";

import type Dockerode from "dockerode";
import {
    HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES,
    type HappySystemPromptHookInput,
    type HappyTracingEvent,
} from "happy-plugins";
import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { GeneratedMediaStore } from "../generated-media/index.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import type { EventId, PluginLogSnapshot, PluginSummary } from "../protocol/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { DaemonLog } from "../server/DaemonLog.js";
import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import type {
    ManagedNetworkHttpRequest,
    ManagedNetworkInterceptor,
} from "../agent/context/ManagedNetworkPolicy.js";
import type { HappyNetworkRequestCompletion, HappyNetworkTunnel } from "happy-plugins";
import type { Skill } from "../agent/skills/Skill.js";
import { loadSkills } from "../agent/skills/loadSkills.js";
import { discoverPlugins } from "./discoverPlugins.js";
import { createPluginDockerClient } from "./createPluginDockerClient.js";
import { discoverGitHubPlugins } from "./discoverGitHubPlugins.js";
import type { GitHubFetch } from "./fetchBoundedGitHubResource.js";
import { getPluginDataDirectory } from "./getPluginDataDirectory.js";
import { getPluginsDirectory } from "./getPluginsDirectory.js";
import type {
    GitHubPluginIndex,
    GitHubPluginInstallSource,
    GitHubPluginSource,
} from "./githubPluginCatalog.js";
import { installGitHubPlugin } from "./installGitHubPlugin.js";
import { installPluginFromPath, type InstalledPlugin } from "./installPluginFromPath.js";
import { PluginNotFoundError } from "./PluginNotFoundError.js";
import { readPluginManifest } from "./readPluginManifest.js";
import { removePluginDockerImages } from "./preparePluginDockerImage.js";
import { resolvePluginDockerImage } from "./resolvePluginDockerRuntime.js";
import type { PluginDiscovery, RegisteredPlugin } from "./types.js";
import { PluginComputeRegistry } from "./PluginComputeRegistry.js";
import { PluginHookRegistry } from "./PluginHookRegistry.js";
import type { PluginMcpRegistry } from "./PluginMcpRegistry.js";
import { PluginNetworkRegistry } from "./PluginNetworkRegistry.js";
import { PluginAppRegistry, type PluginAppResource } from "./PluginAppRegistry.js";
import { boundPluginLogText, readBoundedPluginLog } from "./readBoundedPluginLog.js";
import { startPlugin, type RunningPlugin, type StartPluginOptions } from "./startPlugin.js";
import { removePluginDockerContainers } from "./startPluginDockerContainer.js";
import { DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS } from "./PluginStartupState.js";

const PLUGIN_STATUS_PUBLICATION_INTERVAL_MS = 100;
const PLUGIN_PROCESS_EXIT_SETTLE_MS = 100;

export interface PluginManagerOptions {
    appRegistry?: PluginAppRegistry;
    computeRegistry?: PluginComputeRegistry;
    daemonLog: DaemonLog;
    defaultDocker?: DockerExecutionConfig;
    directory?: string;
    docker?: Dockerode;
    dockerCleanupTimeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
    githubFetch?: GitHubFetch;
    generatedMedia?: GeneratedMediaStore;
    hookRegistry?: PluginHookRegistry;
    now?: () => number;
    mcpRegistry?: PluginMcpRegistry;
    networkRegistry?: PluginNetworkRegistry;
    listProviderUsage?: StartPluginOptions["listProviderUsage"];
    /** How a registered plugin is started. Tests replace the real sandboxed process. */
    start?: (plugin: RegisteredPlugin, options: StartPluginOptions) => Promise<RunningPlugin>;
    startupTimeoutMs?: number;
    store: SessionStore;
}

export interface UninstalledPlugin {
    dataDirectory: string;
    folder: string;
    name: string;
}

interface PluginRuntimeState {
    error?: string;
    logTruncated?: boolean;
    logPath?: string;
    status: PluginSummary["status"];
    statusMessage?: string;
    updatedAt: number;
}

interface PluginCatalog {
    failures: readonly { error: string; folder: string }[];
    plugins: readonly PluginSummary[];
    version: EventId;
}

type StatusPublicationState =
    | { status: "idle" }
    | { status: "publishing" }
    | { status: "publishing_pending" }
    | { status: "scheduled"; timer: NodeJS.Timeout };

/**
 * Owns every installed plugin's lifecycle.
 *
 * Installing and uninstalling take effect immediately: a newly installed plugin is started before
 * the call returns, and an uninstalled one is stopped before its code is removed. Each change
 * publishes the whole current set so attached clients stay in step without polling.
 */
export class PluginManager implements ManagedNetworkInterceptor {
    readonly directory: string;

    readonly #appRegistry: PluginAppRegistry;
    #catalog: { promise: Promise<PluginCatalog>; version: EventId } | undefined;
    readonly #createEventId = createEventIdFactory();
    #catalogVersion: EventId = this.#createEventId();
    readonly #computeRegistry: PluginComputeRegistry;
    readonly #daemonLog: DaemonLog;
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #docker: Dockerode;
    readonly #dockerCleanupTimeoutMs: number | undefined;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #githubFetch: GitHubFetch | undefined;
    readonly #generatedMedia: GeneratedMediaStore | undefined;
    readonly #hookRegistry: PluginHookRegistry;
    #discovery: { promise: Promise<PluginDiscovery>; version: EventId } | undefined;
    readonly #now: () => number;
    readonly #mcpRegistry: PluginMcpRegistry | undefined;
    readonly #networkRegistry: PluginNetworkRegistry;
    readonly #listProviderUsage: StartPluginOptions["listProviderUsage"];
    readonly #running = new Map<string, RunningPlugin>();
    readonly #startupGenerations = new Map<string, symbol>();
    readonly #states = new Map<string, PluginRuntimeState>();
    readonly #start: (
        plugin: RegisteredPlugin,
        options: StartPluginOptions,
    ) => Promise<RunningPlugin>;
    readonly #store: SessionStore;
    readonly #startupTimeoutMs: number;
    readonly #unsubscribeCompute: () => void;
    #statusPublication: StatusPublicationState = { status: "idle" };
    #closed = false;
    #publication = Promise.resolve();
    #started = false;

    constructor(options: PluginManagerOptions) {
        if (options.mcpRegistry === undefined && options.appRegistry === undefined) {
            throw new Error("PluginManager requires the shared MCP registry.");
        }
        this.#appRegistry = options.appRegistry ?? new PluginAppRegistry(options.mcpRegistry!);
        this.#daemonLog = options.daemonLog;
        this.#computeRegistry =
            options.computeRegistry ??
            new PluginComputeRegistry({
                log: (level, event, message, details) =>
                    this.#daemonLog.record(level, event, message, details),
            });
        this.#unsubscribeCompute = this.#computeRegistry.subscribe(() => {
            if (this.#started) void this.#publishChanged();
        });
        this.#defaultDocker = options.defaultDocker;
        this.#docker = options.docker ?? createPluginDockerClient(options.defaultDocker);
        this.#dockerCleanupTimeoutMs = options.dockerCleanupTimeoutMs;
        this.#environment = options.environment ?? process.env;
        this.#githubFetch = options.githubFetch;
        this.#generatedMedia = options.generatedMedia;
        this.#hookRegistry =
            options.hookRegistry ??
            new PluginHookRegistry({
                log: (level, event, message, details) =>
                    this.#daemonLog.record(level, event, message, details),
            });
        this.#now = options.now ?? Date.now;
        this.#mcpRegistry = options.mcpRegistry;
        this.#networkRegistry =
            options.networkRegistry ??
            new PluginNetworkRegistry({
                onFailure: (failure) => {
                    this.#daemonLog.record(
                        "warning",
                        "plugin_network_interception_failed",
                        "A plugin network interception failed open to normal proxy behavior.",
                        failure,
                    );
                },
            });
        this.#listProviderUsage = options.listProviderUsage;
        this.#start = options.start ?? startPlugin;
        this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS;
        this.#store = options.store;
        this.directory = options.directory ?? getPluginsDirectory(this.#environment);
    }

    async start(): Promise<void> {
        if (this.#started) return;
        this.#started = true;
        const discovery = await discoverPlugins(this.directory);
        for (const failure of discovery.failures) {
            this.#daemonLog.record(
                "error",
                "plugin_registration_failed",
                `Rig could not register the plugin in ${failure.folderName}.`,
                {
                    directory: failure.directory,
                    error: failure.error,
                    pluginFolder: failure.folderName,
                },
            );
        }
        await Promise.all(
            discovery.plugins.map((plugin) =>
                this.#closed ? Promise.resolve() : this.#startRegistered(plugin.folderName),
            ),
        );
        await this.#publishChanged();
    }

    /** Installs a plugin from a folder on this machine and starts it. */
    async install(options: {
        fs: FileSystemContext;
        signal?: AbortSignal;
        sourceDirectory: string;
    }): Promise<InstalledPlugin> {
        this.#assertOpen();
        const installed = await installPluginFromPath({
            docker: this.#docker,
            fs: options.fs,
            pluginsDirectory: this.directory,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            sourceDirectory: options.sourceDirectory,
        });
        await this.#activateInstalled(installed);
        return installed;
    }

    /** Lists the plugins published by a GitHub repository index. */
    async discoverRepository(
        source: GitHubPluginSource,
        signal?: AbortSignal,
    ): Promise<GitHubPluginIndex> {
        this.#assertOpen();
        return discoverGitHubPlugins(source, {
            ...(this.#githubFetch === undefined ? {} : { fetcher: this.#githubFetch }),
            ...(signal === undefined ? {} : { signal }),
        });
    }

    /** Installs one indexed plugin from a GitHub repository and starts it. */
    async installFromGitHub(
        source: GitHubPluginInstallSource,
        options: { fs: FileSystemContext; signal?: AbortSignal },
    ): Promise<InstalledPlugin> {
        this.#assertOpen();
        const installed = await installGitHubPlugin({
            docker: this.#docker,
            ...(this.#githubFetch === undefined ? {} : { fetcher: this.#githubFetch }),
            fs: options.fs,
            pluginsDirectory: this.directory,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            source,
        });
        await this.#activateInstalled(installed);
        return installed;
    }

    async #activateInstalled(installed: InstalledPlugin): Promise<void> {
        // Replacing an installed plugin retires the process built from the previous code.
        await this.#stopRunning(installed.folder, true);
        await this.#startRegistered(installed.folder, { preserveLog: true });
        try {
            const plugin = await readPluginManifest(installed.directory);
            if (plugin.docker !== undefined) {
                await removePluginDockerImages(installed.folder, {
                    docker: this.#docker,
                    ...(this.#dockerCleanupTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: this.#dockerCleanupTimeoutMs }),
                    ...(plugin.docker.type === "dockerfile"
                        ? { keepImage: await resolvePluginDockerImage(plugin) }
                        : {}),
                });
            }
        } catch (error) {
            this.#recordDockerCleanupFailure(installed.name, "remove superseded images", error);
        }
        await this.#publishChanged({ installation: installed });
    }

    /** Stops a plugin and removes its installed code, keeping the folder it writes to. */
    async uninstall(options: {
        fs: FileSystemContext;
        name: string;
        signal?: AbortSignal;
    }): Promise<UninstalledPlugin> {
        this.#assertOpen();
        options.signal?.throwIfAborted();
        const discovery = await discoverPlugins(this.directory);
        const wanted = options.name.trim().toLowerCase();
        const installed = discovery.plugins.find(
            (plugin) =>
                plugin.manifest.name.toLowerCase() === wanted ||
                plugin.folderName.toLowerCase() === wanted,
        );
        if (installed === undefined) {
            const known = discovery.plugins.map((plugin) => plugin.manifest.name);
            throw new PluginNotFoundError(
                known.length === 0
                    ? `No plugin named ${options.name} is installed. No plugins are installed.`
                    : `No plugin named ${options.name} is installed. Installed plugins: ${known.join(", ")}.`,
            );
        }
        options.signal?.throwIfAborted();
        await this.#stopRunning(installed.folderName);
        if (installed.docker !== undefined) {
            await Promise.all([
                removePluginDockerContainers(installed.folderName, {
                    docker: this.#docker,
                    ...(this.#dockerCleanupTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: this.#dockerCleanupTimeoutMs }),
                }).catch((error: unknown) =>
                    this.#recordDockerCleanupFailure(
                        installed.manifest.name,
                        "remove containers during uninstall",
                        error,
                    ),
                ),
                removePluginDockerImages(installed.folderName, {
                    docker: this.#docker,
                    ...(this.#dockerCleanupTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: this.#dockerCleanupTimeoutMs }),
                }).catch((error: unknown) =>
                    this.#recordDockerCleanupFailure(
                        installed.manifest.name,
                        "remove images during uninstall",
                        error,
                    ),
                ),
            ]);
        }
        await options.fs.rm(join(this.directory, installed.folderName), {
            force: true,
            recursive: true,
        });
        this.#store.slots.removeByPluginAuthor(installed.folderName);
        this.#states.delete(installed.folderName);
        this.#daemonLog.record(
            "info",
            "plugin_uninstalled",
            `The ${installed.manifest.name} plugin was uninstalled.`,
            {
                dataDirectory: getPluginDataDirectory(installed.folderName, this.#environment),
                plugin: installed.manifest.name,
                pluginFolder: installed.folderName,
            },
        );
        await this.#publishChanged();
        return {
            dataDirectory: getPluginDataDirectory(installed.folderName, this.#environment),
            folder: installed.folderName,
            name: installed.manifest.name,
        };
    }

    /** Every installed plugin, with the ones currently running marked. */
    async list(): Promise<PluginCatalog> {
        for (;;) {
            const version = this.#catalogVersion;
            const cached =
                this.#catalog?.version === version
                    ? this.#catalog
                    : {
                          promise: this.#readCatalog(version),
                          version,
                      };
            this.#catalog = cached;
            let catalog: PluginCatalog;
            try {
                catalog = await cached.promise;
            } catch (error) {
                if (this.#catalog === cached) this.#catalog = undefined;
                throw error;
            }
            if (version === this.#catalogVersion) return catalog;
        }
    }

    /** Loads the normal skill catalog with contributions from active plugins. */
    async loadSkills(fs: FileSystemContext): Promise<readonly Skill[]> {
        let discovery: PluginDiscovery;
        try {
            discovery = await this.#discoverCurrentPlugins();
        } catch (error) {
            this.#daemonLog.record(
                "warning",
                "plugin_skills_unreadable",
                "Rig could not read plugin skills; continuing with file skills.",
                { error: errorToMessage(error) },
            );
            return loadSkills(fs);
        }
        return loadSkills(fs, {
            additionalRoots: discovery.plugins.flatMap((plugin) =>
                this.#states.get(plugin.folderName)?.status === "running" &&
                plugin.skillsPath !== undefined
                    ? [
                          {
                              path: plugin.skillsPath,
                              source: {
                                  folder: plugin.folderName,
                                  plugin: plugin.manifest.name,
                                  type: "plugin" as const,
                              },
                          },
                      ]
                    : [],
            ),
            onInvalidSkill: (filePath, root) => {
                if (root.source.type !== "plugin") return;
                this.#daemonLog.record(
                    "warning",
                    "plugin_skill_skipped",
                    `Rig skipped an invalid skill from the ${root.source.plugin} plugin.`,
                    {
                        plugin: root.source.plugin,
                        pluginFolder: root.source.folder,
                        skillPath: filePath,
                    },
                );
            },
            onSkillCollision: ({ kept, skipped }) => {
                if (skipped.source.type !== "plugin") return;
                this.#daemonLog.record(
                    "warning",
                    "plugin_skill_name_collision",
                    `Rig skipped the ${skipped.source.plugin} plugin's ${skipped.name} skill because another skill has the same name.`,
                    {
                        keptSource:
                            kept.source.type === "file" ? "file" : `plugin: ${kept.source.plugin}`,
                        plugin: skipped.source.plugin,
                        pluginFolder: skipped.source.folder,
                        skill: skipped.name,
                    },
                );
            },
        });
    }

    /** Appends active static contributions in deterministic plugin-folder order. */
    async loadSystemPrompt(): Promise<string | undefined> {
        let discovery: PluginDiscovery;
        try {
            discovery = await this.#discoverCurrentPlugins();
        } catch (error) {
            this.#daemonLog.record(
                "warning",
                "plugin_system_prompts_unreadable",
                "Rig could not read plugin system prompts; continuing without them.",
                { error: errorToMessage(error) },
            );
            return undefined;
        }
        const contributions: string[] = [];
        let bytes = 0;
        for (const plugin of discovery.plugins) {
            if (
                this.#states.get(plugin.folderName)?.status !== "running" ||
                plugin.systemPrompt === undefined
            ) {
                continue;
            }
            const separatorBytes = contributions.length === 0 ? 0 : 2;
            const contributionBytes = Buffer.byteLength(plugin.systemPrompt, "utf8");
            if (bytes + separatorBytes + contributionBytes > HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES) {
                this.#daemonLog.record(
                    "warning",
                    "plugin_system_prompt_skipped",
                    `Rig skipped the ${plugin.manifest.name} plugin's system prompt because active plugin contributions reached the size limit.`,
                    {
                        plugin: plugin.manifest.name,
                        pluginFolder: plugin.folderName,
                    },
                );
                continue;
            }
            contributions.push(plugin.systemPrompt);
            bytes += separatorBytes + contributionBytes;
        }
        return contributions.length === 0 ? undefined : contributions.join("\n\n");
    }

    applySystemPrompt(input: HappySystemPromptHookInput): Promise<string> {
        return this.#hookRegistry.applySystemPrompt(input);
    }

    trace(event: HappyTracingEvent): void {
        this.#hookRegistry.emit(event);
    }

    async #readCatalog(version: EventId): Promise<PluginCatalog> {
        const discovery = await this.#readDiscovery(version);
        return {
            failures: discovery.failures.map((failure) => ({
                error: failure.error,
                folder: failure.folderName,
            })),
            plugins: discovery.plugins.map((plugin) => {
                const state = this.#states.get(plugin.folderName) ?? {
                    status: "stopped" as const,
                    updatedAt: this.#now(),
                };
                const compute =
                    state.status === "running"
                        ? this.#computeRegistry
                              .list()
                              .find((provider) => provider.pluginFolder === plugin.folderName)
                        : undefined;
                return {
                    apps:
                        state.status === "running" ? this.#appRegistry.list(plugin.folderName) : [],
                    ...(compute === undefined
                        ? {}
                        : { compute: { health: compute.health, name: compute.name } }),
                    dataDirectory: getPluginDataDirectory(plugin.folderName, this.#environment),
                    description: plugin.manifest.description,
                    directory: plugin.directory,
                    ...(state.error === undefined ? {} : { error: state.error }),
                    folder: plugin.folderName,
                    logAvailable: state.error !== undefined || state.logPath !== undefined,
                    name: plugin.manifest.name,
                    status: state.status,
                    ...(state.statusMessage === undefined
                        ? {}
                        : { statusMessage: state.statusMessage }),
                    version: plugin.manifest.version,
                };
            }),
            version,
        };
    }

    async #discoverCurrentPlugins(): Promise<PluginDiscovery> {
        for (;;) {
            const version = this.#catalogVersion;
            const discovery = await this.#readDiscovery(version);
            if (version === this.#catalogVersion) return discovery;
        }
    }

    async #readDiscovery(version: EventId): Promise<PluginDiscovery> {
        const cached =
            this.#discovery?.version === version
                ? this.#discovery
                : {
                      promise: discoverPlugins(this.directory),
                      version,
                  };
        this.#discovery = cached;
        try {
            return await cached.promise;
        } catch (error) {
            if (this.#discovery === cached) this.#discovery = undefined;
            throw error;
        }
    }

    /** Reads at most the current plugin log's fixed retention bound. */
    async readLog(name: string): Promise<PluginLogSnapshot> {
        const discovery = await discoverPlugins(this.directory);
        const wanted = name.trim().toLowerCase();
        const plugin = discovery.plugins.find(
            (candidate) =>
                candidate.folderName.toLowerCase() === wanted ||
                candidate.manifest.name.toLowerCase() === wanted,
        );
        if (plugin === undefined) throw new Error(`No installed plugin is named ${name}.`);
        const state = this.#states.get(plugin.folderName) ?? {
            status: "stopped" as const,
            updatedAt: this.#now(),
        };
        const output =
            state.status === "failed"
                ? {
                      text: state.error ?? "The plugin failed to start.",
                      truncated: state.logTruncated ?? false,
                  }
                : state.logPath === undefined
                  ? { text: "", truncated: false }
                  : await readBoundedPluginLog(state.logPath);
        return {
            ...(state.error === undefined ? {} : { error: state.error }),
            folder: plugin.folderName,
            name: plugin.manifest.name,
            source: state.status === "failed" ? "error" : "current_run",
            status: state.status,
            text: output.text,
            truncated: output.truncated,
            updatedAt: state.updatedAt,
        };
    }

    readAppResource(
        applicationId: string,
        generation: string,
        resourceUri: string,
    ): PluginAppResource {
        return this.#appRegistry.readResource(applicationId, generation, resourceUri);
    }

    callAppTool(
        applicationId: string,
        generation: string,
        server: string,
        tool: string,
        input: unknown,
        signal?: AbortSignal,
    ) {
        return this.#appRegistry.callTool(applicationId, generation, server, tool, input, signal);
    }

    storageGet(applicationId: string, generation: string, key: string) {
        return this.#appRegistry.storageGet(applicationId, generation, key);
    }
    storageList(applicationId: string, generation: string) {
        return this.#appRegistry.storageList(applicationId, generation);
    }
    storageSet(applicationId: string, generation: string, key: string, value: unknown) {
        return this.#appRegistry.storageSet(applicationId, generation, key, value);
    }
    storageDelete(applicationId: string, generation: string, key: string) {
        return this.#appRegistry.storageDelete(applicationId, generation, key);
    }

    interceptHttp(request: ManagedNetworkHttpRequest): Promise<HappyNetworkRequestCompletion> {
        return this.#networkRegistry.interceptHttp(request);
    }

    observeTunnel(tunnel: HappyNetworkTunnel): void {
        this.#networkRegistry.observeTunnel(tunnel);
    }

    recordFailure(hostname: string, error: unknown): void {
        this.#networkRegistry.recordFailure(hostname, error);
    }

    shouldIntercept(hostname: string): boolean {
        return this.#networkRegistry.shouldIntercept(hostname);
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#statusPublication.status === "scheduled") {
            clearTimeout(this.#statusPublication.timer);
        }
        this.#statusPublication = { status: "idle" };
        this.#startupGenerations.clear();
        this.#unsubscribeCompute();
        await this.#computeRegistry.close();
        await Promise.all(
            [...this.#running.values()].map((plugin) =>
                plugin.close().catch((error: unknown) => {
                    this.#daemonLog.record(
                        "warning",
                        "plugin_stop_cleanup_failed",
                        `Rig could not completely clean up the ${plugin.name} plugin while shutting down.`,
                        { error: errorToMessage(error), plugin: plugin.name },
                    );
                }),
            ),
        );
        this.#running.clear();
        this.#networkRegistry.close();
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("Rig is shutting down, so plugins cannot change now.");
    }

    async #startRegistered(
        folderName: string,
        options: { preserveLog?: boolean } = {},
    ): Promise<void> {
        const startupGeneration = Symbol(folderName);
        this.#startupGenerations.set(folderName, startupGeneration);
        const isCurrentStartup = () =>
            this.#startupGenerations.get(folderName) === startupGeneration;
        const directory = join(this.directory, folderName);
        let name = folderName;
        let running: RunningPlugin | undefined;
        try {
            const plugin = await readPluginManifest(directory);
            name = plugin.manifest.name;
            if (plugin.entryPath === undefined) {
                if (this.#closed || !isCurrentStartup()) return;
                this.#states.set(folderName, {
                    status: "running",
                    updatedAt: this.#now(),
                });
                this.#daemonLog.record("info", "plugin_started", `The ${name} plugin started.`, {
                    plugin: name,
                    pluginDirectory: directory,
                });
                return;
            }
            const startupStartedAt = Date.now();
            const starting = this.#start(plugin, {
                appRegistry: this.#appRegistry,
                computeRegistry: this.#computeRegistry,
                ...(this.#defaultDocker === undefined
                    ? {}
                    : { defaultDocker: this.#defaultDocker }),
                environment: this.#environment,
                docker: this.#docker,
                ...(this.#dockerCleanupTimeoutMs === undefined
                    ? {}
                    : { dockerCleanupTimeoutMs: this.#dockerCleanupTimeoutMs }),
                ...(this.#generatedMedia === undefined
                    ? {}
                    : { generatedMedia: this.#generatedMedia }),
                hookRegistry: this.#hookRegistry,
                ...(this.#listProviderUsage === undefined
                    ? {}
                    : { listProviderUsage: this.#listProviderUsage }),
                listPlugins: async () => (await this.list()).plugins,
                ...(this.#mcpRegistry === undefined ? {} : { mcpRegistry: this.#mcpRegistry }),
                networkRegistry: this.#networkRegistry,
                onStatus: (status) => this.#updatePluginStatus(folderName, status),
                ...(options.preserveLog === true ? { preserveLog: true } : {}),
                store: this.#store,
            });
            running = await startPluginWithin(starting, this.#startupTimeoutMs);
            if (this.#closed || !isCurrentStartup()) {
                running.startup.fail("Rig shut down while the plugin was starting.");
                await running.close({ force: true });
                return;
            }
            this.#running.set(folderName, running);
            const currentRunning = running;
            void running.retirement.then((retirement) =>
                retirement.status === "failed"
                    ? this.#failRunning(
                          folderName,
                          name,
                          directory,
                          currentRunning,
                          retirement.reason,
                      )
                    : this.#stopRetiredRunning(folderName, currentRunning),
            );
            const startupElapsedMs = Date.now() - startupStartedAt;
            const startup = await waitForPluginStartup(
                running,
                Math.max(0, this.#startupTimeoutMs - startupElapsedMs),
                this.#startupTimeoutMs,
            );
            if (this.#closed || !isCurrentStartup() || this.#running.get(folderName) !== running) {
                await running.close({ force: true });
                return;
            }
            if (startup.status === "failed") {
                this.#running.delete(folderName);
                const diagnostic = boundPluginLogText(startup.error);
                this.#states.set(folderName, {
                    error: diagnostic.text,
                    logPath: running.logPath,
                    logTruncated: diagnostic.truncated,
                    status: "failed",
                    ...(running.statusMessage === undefined
                        ? {}
                        : { statusMessage: running.statusMessage }),
                    updatedAt: this.#now(),
                });
                this.#daemonLog.record(
                    "error",
                    "plugin_start_failed",
                    `Rig could not start the ${name} plugin.`,
                    { error: diagnostic.text, plugin: name, pluginDirectory: directory },
                );
                await running.close({ force: true });
                return;
            }
            this.#states.set(folderName, {
                logPath: running.logPath,
                status: "running",
                ...(running.statusMessage === undefined
                    ? {}
                    : { statusMessage: running.statusMessage }),
                updatedAt: this.#now(),
            });
            this.#daemonLog.record("info", "plugin_started", `The ${name} plugin started.`, {
                dataDirectory: running.dataDirectory,
                logPath: running.logPath,
                pid: running.pid,
                plugin: name,
                pluginDirectory: directory,
            });
            void running.completion.then(
                ({ code, signal }) => {
                    const exitError =
                        code !== null && code !== 0
                            ? `The plugin exited with code ${String(code)}.`
                            : signal === null
                              ? undefined
                              : `The plugin exited after receiving ${signal}.`;
                    this.#forgetExited(
                        folderName,
                        currentRunning,
                        exitError === undefined ? {} : { error: exitError },
                    );
                    this.#daemonLog.record(
                        code === 0 ? "info" : "warning",
                        "plugin_exited",
                        `The ${name} plugin exited.`,
                        {
                            ...(code === null ? {} : { exitCode: code }),
                            plugin: name,
                            ...(signal === null ? {} : { signal }),
                        },
                    );
                },
                (error: unknown) => {
                    this.#forgetExited(folderName, currentRunning, {
                        error: errorToMessage(error),
                    });
                    this.#daemonLog.record(
                        "error",
                        "plugin_process_failed",
                        `The ${name} plugin process failed.`,
                        { error: errorToMessage(error), plugin: name },
                    );
                },
            );
        } catch (error) {
            if (this.#closed || !isCurrentStartup()) {
                if (running !== undefined) await running.close({ force: true });
                return;
            }
            if (running !== undefined) {
                if (this.#running.get(folderName) === running) {
                    this.#running.delete(folderName);
                }
                await running.close({ force: true });
            }
            const diagnostic = boundPluginLogText(errorToMessage(error));
            this.#states.set(folderName, {
                error: diagnostic.text,
                logTruncated: diagnostic.truncated,
                status: "failed",
                updatedAt: this.#now(),
            });
            this.#daemonLog.record(
                "error",
                "plugin_start_failed",
                `Rig could not start the ${name} plugin.`,
                { error: diagnostic.text, plugin: name, pluginDirectory: directory },
            );
        } finally {
            if (isCurrentStartup()) this.#startupGenerations.delete(folderName);
        }
    }

    async #stopRunning(folderName: string, publishStopped = false): Promise<void> {
        this.#startupGenerations.delete(folderName);
        const running = this.#running.get(folderName);
        if (running === undefined) {
            if (this.#states.get(folderName)?.status !== "running") return;
            this.#states.set(folderName, {
                status: "stopped",
                updatedAt: this.#now(),
            });
            if (publishStopped) await this.#publishChanged();
            return;
        }
        this.#running.delete(folderName);
        await running.close().catch((error: unknown) => {
            this.#daemonLog.record(
                "warning",
                "plugin_stop_cleanup_failed",
                `Rig could not completely clean up the ${running.name} plugin while stopping it.`,
                { error: errorToMessage(error), plugin: running.name },
            );
        });
        this.#states.set(folderName, {
            logPath: running.logPath,
            status: "stopped",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        if (publishStopped) await this.#publishChanged();
    }

    #recordDockerCleanupFailure(plugin: string, action: string, error: unknown): void {
        this.#daemonLog.record(
            "warning",
            "plugin_docker_cleanup_failed",
            `Rig could not ${action} for the ${plugin} plugin. The plugin change still completed.`,
            { error: errorToMessage(error), plugin },
        );
    }

    #updatePluginStatus(folderName: string, statusMessage: string): void {
        const state = this.#states.get(folderName);
        if (state?.status !== "running") return;
        this.#states.set(folderName, {
            ...state,
            statusMessage,
            updatedAt: this.#now(),
        });
        this.#scheduleStatusPublication();
    }

    #scheduleStatusPublication(): void {
        if (this.#closed) return;
        if (this.#statusPublication.status === "publishing") {
            this.#statusPublication = { status: "publishing_pending" };
            return;
        }
        if (this.#statusPublication.status !== "idle") return;
        const timer = setTimeout(() => {
            if (
                this.#statusPublication.status !== "scheduled" ||
                this.#statusPublication.timer !== timer
            ) {
                return;
            }
            this.#statusPublication = { status: "publishing" };
            void this.#publishChanged().finally(() => this.#finishStatusPublication());
        }, PLUGIN_STATUS_PUBLICATION_INTERVAL_MS);
        timer.unref();
        this.#statusPublication = { status: "scheduled", timer };
    }

    #finishStatusPublication(): void {
        if (this.#closed) {
            this.#statusPublication = { status: "idle" };
            return;
        }
        const publishAgain = this.#statusPublication.status === "publishing_pending";
        this.#statusPublication = { status: "idle" };
        if (publishAgain) this.#scheduleStatusPublication();
    }

    async #failRunning(
        folderName: string,
        name: string,
        directory: string,
        running: RunningPlugin,
        error: string,
    ): Promise<void> {
        if (this.#closed || this.#running.get(folderName) !== running) return;
        if (await exitsWithin(running.completion, PLUGIN_PROCESS_EXIT_SETTLE_MS)) return;
        if (this.#closed || this.#running.get(folderName) !== running) return;
        this.#running.delete(folderName);
        const diagnostic = boundPluginLogText(error);
        this.#states.set(folderName, {
            error: diagnostic.text,
            logPath: running.logPath,
            logTruncated: diagnostic.truncated,
            status: "failed",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        this.#daemonLog.record(
            "error",
            "plugin_runtime_failed",
            `The ${name} plugin failed while it was running.`,
            { error: diagnostic.text, plugin: name, pluginDirectory: directory },
        );
        await Promise.allSettled([running.close({ force: true }), this.#publishChanged()]);
    }

    async #stopRetiredRunning(folderName: string, running: RunningPlugin): Promise<void> {
        if (this.#closed || this.#running.get(folderName) !== running) return;
        this.#running.delete(folderName);
        await running.close();
        this.#states.set(folderName, {
            logPath: running.logPath,
            status: "stopped",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        await this.#publishChanged();
    }

    /** A plugin that ends on its own leaves the running set, and clients see it stop. */
    #forgetExited(folderName: string, running: RunningPlugin, options: { error?: string }): void {
        if (this.#running.get(folderName) !== running) return;
        this.#running.delete(folderName);
        const boundedError =
            options.error === undefined ? undefined : boundPluginLogText(options.error);
        this.#states.set(folderName, {
            ...(boundedError === undefined
                ? {}
                : { error: boundedError.text, logTruncated: boundedError.truncated }),
            logPath: running.logPath,
            status: "stopped",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        void this.#publishChanged();
    }

    async #publishChanged(options: { installation?: InstalledPlugin } = {}): Promise<void> {
        const eventId = this.#createEventId();
        this.#catalogVersion = eventId;
        const publish = async () => {
            if (this.#closed) return;
            let catalog: Awaited<ReturnType<PluginManager["list"]>>;
            try {
                catalog = await this.list();
            } catch (error) {
                this.#daemonLog.record(
                    "warning",
                    "plugins_unreadable",
                    "Rig could not read the plugins folder to announce a change.",
                    { error: errorToMessage(error) },
                );
                return;
            }
            if (this.#closed || catalog.version !== eventId) return;
            const event = {
                createdAt: this.#now(),
                data: {
                    ...catalog,
                    ...(options.installation === undefined
                        ? {}
                        : { installation: options.installation }),
                },
                id: eventId,
                type: "plugins_changed" as const,
            };
            this.#store.globalEventQueue.publishLive(event);
            this.#store.liveEvents.publish(event);
        };
        const next = this.#publication.then(publish, publish);
        this.#publication = next.catch(() => undefined);
        await next;
    }
}

async function waitForPluginStartup(
    running: RunningPlugin,
    timeoutMs: number,
    reportedTimeoutMs = timeoutMs,
): Promise<{ status: "running" } | { error: string; status: "failed" }> {
    const timer = setTimeout(
        () =>
            running.startup.fail(
                `The plugin did not report ready within ${formatStartupDuration(reportedTimeoutMs)}.`,
            ),
        timeoutMs,
    );
    timer.unref();
    void running.completion.then(
        ({ code, signal }) => {
            running.startup.fail(
                code !== null && code !== 0
                    ? `The plugin exited with code ${String(code)} before reporting ready.`
                    : signal === null
                      ? "The plugin exited before reporting ready."
                      : `The plugin exited after receiving ${signal} before reporting ready.`,
            );
        },
        (error: unknown) => {
            running.startup.fail(errorToMessage(error));
        },
    );
    try {
        return await running.startup.settled;
    } finally {
        clearTimeout(timer);
    }
}

async function startPluginWithin(
    starting: Promise<RunningPlugin>,
    timeoutMs: number,
): Promise<RunningPlugin> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    void starting.then(
        async (running) => {
            if (timedOut) await running.close({ force: true });
        },
        () => {},
    );
    try {
        return await Promise.race([
            starting,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    reject(
                        new Error(
                            `The plugin did not report ready within ${formatStartupDuration(timeoutMs)}.`,
                        ),
                    );
                }, timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function exitsWithin(
    completion: RunningPlugin["completion"],
    timeoutMs: number,
): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            completion.then(
                () => true,
                () => true,
            ),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function formatStartupDuration(timeoutMs: number): string {
    if (timeoutMs < 1_000) {
        return `${String(timeoutMs)} ${timeoutMs === 1 ? "millisecond" : "milliseconds"}`;
    }
    const seconds = timeoutMs / 1_000;
    const formatted = Number(seconds.toFixed(3));
    return `${String(formatted)} ${formatted === 1 ? "second" : "seconds"}`;
}
