import { join } from "node:path";

import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { GeneratedMediaStore } from "../generated-media/index.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import type { EventId, PluginLogSnapshot, PluginSummary } from "../protocol/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { DaemonLog } from "../server/DaemonLog.js";
import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { discoverPlugins } from "./discoverPlugins.js";
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
import type { RegisteredPlugin } from "./types.js";
import type { PluginMcpRegistry } from "./PluginMcpRegistry.js";
import { PluginAppRegistry, type PluginAppResource } from "./PluginAppRegistry.js";
import { boundPluginLogText, readBoundedPluginLog } from "./readBoundedPluginLog.js";
import { startPlugin, type RunningPlugin, type StartPluginOptions } from "./startPlugin.js";

export interface PluginManagerOptions {
    appRegistry?: PluginAppRegistry;
    daemonLog: DaemonLog;
    defaultDocker?: DockerExecutionConfig;
    directory?: string;
    environment?: NodeJS.ProcessEnv;
    githubFetch?: GitHubFetch;
    generatedMedia?: GeneratedMediaStore;
    now?: () => number;
    mcpRegistry?: PluginMcpRegistry;
    listProviderUsage?: StartPluginOptions["listProviderUsage"];
    /** How a registered plugin is started. Tests replace the real sandboxed process. */
    start?: (plugin: RegisteredPlugin, options: StartPluginOptions) => Promise<RunningPlugin>;
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
    updatedAt: number;
}

interface PluginCatalog {
    failures: readonly { error: string; folder: string }[];
    plugins: readonly PluginSummary[];
    version: EventId;
}

/**
 * Owns every installed plugin's lifecycle.
 *
 * Installing and uninstalling take effect immediately: a newly installed plugin is started before
 * the call returns, and an uninstalled one is stopped before its code is removed. Each change
 * publishes the whole current set so attached clients stay in step without polling.
 */
export class PluginManager {
    readonly directory: string;

    readonly #appRegistry: PluginAppRegistry;
    #catalog: { promise: Promise<PluginCatalog>; version: EventId } | undefined;
    readonly #createEventId = createEventIdFactory();
    #catalogVersion: EventId = this.#createEventId();
    readonly #daemonLog: DaemonLog;
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #githubFetch: GitHubFetch | undefined;
    readonly #generatedMedia: GeneratedMediaStore | undefined;
    readonly #now: () => number;
    readonly #mcpRegistry: PluginMcpRegistry | undefined;
    readonly #listProviderUsage: StartPluginOptions["listProviderUsage"];
    readonly #running = new Map<string, RunningPlugin>();
    readonly #states = new Map<string, PluginRuntimeState>();
    readonly #start: (
        plugin: RegisteredPlugin,
        options: StartPluginOptions,
    ) => Promise<RunningPlugin>;
    readonly #store: SessionStore;
    readonly #unsubscribeApps: () => void;
    readonly #unsubscribeMcp: () => void;
    #closed = false;
    #publication = Promise.resolve();
    #started = false;

    constructor(options: PluginManagerOptions) {
        if (options.mcpRegistry === undefined && options.appRegistry === undefined) {
            throw new Error("PluginManager requires the shared MCP registry.");
        }
        this.#appRegistry = options.appRegistry ?? new PluginAppRegistry(options.mcpRegistry!);
        this.#daemonLog = options.daemonLog;
        this.#defaultDocker = options.defaultDocker;
        this.#environment = options.environment ?? process.env;
        this.#githubFetch = options.githubFetch;
        this.#generatedMedia = options.generatedMedia;
        this.#now = options.now ?? Date.now;
        this.#mcpRegistry = options.mcpRegistry;
        this.#listProviderUsage = options.listProviderUsage;
        this.#start = options.start ?? startPlugin;
        this.#store = options.store;
        this.directory = options.directory ?? getPluginsDirectory(this.#environment);
        this.#unsubscribeApps = this.#appRegistry.subscribe(() => {
            void this.#publishChanged();
        });
        this.#unsubscribeMcp =
            options.mcpRegistry?.subscribe(() => {
                void this.#publishChanged();
            }) ?? (() => {});
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
        for (const plugin of discovery.plugins) {
            if (this.#closed) return;
            await this.#startRegistered(plugin.folderName);
        }
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
        await this.#startRegistered(installed.folder);
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

    async #readCatalog(version: EventId): Promise<PluginCatalog> {
        const discovery = await discoverPlugins(this.directory);
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
                return {
                    apps:
                        state.status === "running" ? this.#appRegistry.list(plugin.folderName) : [],
                    dataDirectory: getPluginDataDirectory(plugin.folderName, this.#environment),
                    description: plugin.manifest.description,
                    directory: plugin.directory,
                    ...(state.error === undefined ? {} : { error: state.error }),
                    folder: plugin.folderName,
                    logAvailable: state.error !== undefined || state.logPath !== undefined,
                    name: plugin.manifest.name,
                    status: state.status,
                    version: plugin.manifest.version,
                };
            }),
            version,
        };
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

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await Promise.all([...this.#running.values()].map((plugin) => plugin.close()));
        this.#running.clear();
        this.#unsubscribeApps();
        this.#unsubscribeMcp();
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("Rig is shutting down, so plugins cannot change now.");
    }

    async #startRegistered(folderName: string): Promise<void> {
        const directory = join(this.directory, folderName);
        let name = folderName;
        try {
            const plugin = await readPluginManifest(directory);
            name = plugin.manifest.name;
            const running = await this.#start(plugin, {
                appRegistry: this.#appRegistry,
                ...(this.#defaultDocker === undefined
                    ? {}
                    : { defaultDocker: this.#defaultDocker }),
                environment: this.#environment,
                ...(this.#generatedMedia === undefined
                    ? {}
                    : { generatedMedia: this.#generatedMedia }),
                ...(this.#listProviderUsage === undefined
                    ? {}
                    : { listProviderUsage: this.#listProviderUsage }),
                listPlugins: async () => (await this.list()).plugins,
                ...(this.#mcpRegistry === undefined ? {} : { mcpRegistry: this.#mcpRegistry }),
                store: this.#store,
            });
            if (this.#closed) {
                await running.close();
                return;
            }
            this.#running.set(folderName, running);
            this.#states.set(folderName, {
                logPath: running.logPath,
                status: "running",
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
                        running,
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
                    this.#forgetExited(folderName, running, {
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
        }
    }

    async #stopRunning(folderName: string, publishStopped = false): Promise<void> {
        const running = this.#running.get(folderName);
        if (running === undefined) return;
        this.#running.delete(folderName);
        await running.close();
        this.#states.set(folderName, {
            logPath: running.logPath,
            status: "stopped",
            updatedAt: this.#now(),
        });
        if (publishStopped) await this.#publishChanged();
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
