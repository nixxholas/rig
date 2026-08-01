import { join } from "node:path";

import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import type { PluginSummary } from "../protocol/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { DaemonLog } from "../server/DaemonLog.js";
import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { discoverPlugins } from "./discoverPlugins.js";
import { getPluginDataDirectory } from "./getPluginDataDirectory.js";
import { getPluginsDirectory } from "./getPluginsDirectory.js";
import { installPluginFromPath, type InstalledPlugin } from "./installPluginFromPath.js";
import { readPluginManifest } from "./readPluginManifest.js";
import type { RegisteredPlugin } from "./types.js";
import { startPlugin, type RunningPlugin, type StartPluginOptions } from "./startPlugin.js";

export interface PluginManagerOptions {
    daemonLog: DaemonLog;
    defaultDocker?: DockerExecutionConfig;
    directory?: string;
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    /** How a registered plugin is started. Tests replace the real sandboxed process. */
    start?: (plugin: RegisteredPlugin, options: StartPluginOptions) => Promise<RunningPlugin>;
    store: SessionStore;
}

export interface UninstalledPlugin {
    dataDirectory: string;
    folder: string;
    name: string;
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

    readonly #createEventId = createEventIdFactory();
    readonly #daemonLog: DaemonLog;
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #now: () => number;
    readonly #running = new Map<string, RunningPlugin>();
    readonly #start: (
        plugin: RegisteredPlugin,
        options: StartPluginOptions,
    ) => Promise<RunningPlugin>;
    readonly #store: SessionStore;
    #closed = false;
    #started = false;

    constructor(options: PluginManagerOptions) {
        this.#daemonLog = options.daemonLog;
        this.#defaultDocker = options.defaultDocker;
        this.#environment = options.environment ?? process.env;
        this.#now = options.now ?? Date.now;
        this.#start = options.start ?? startPlugin;
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
        for (const plugin of discovery.plugins) {
            if (this.#closed) return;
            await this.#startRegistered(plugin.folderName);
        }
        await this.#publishChanged();
    }

    /** Installs a plugin from a folder on this machine and starts it. */
    async install(options: {
        fs: FileSystemContext;
        sourceDirectory: string;
    }): Promise<InstalledPlugin> {
        this.#assertOpen();
        const installed = await installPluginFromPath({
            fs: options.fs,
            pluginsDirectory: this.directory,
            sourceDirectory: options.sourceDirectory,
        });
        // Replacing an installed plugin retires the process built from the previous code.
        await this.#stopRunning(installed.folder);
        await this.#startRegistered(installed.folder);
        await this.#publishChanged();
        return installed;
    }

    /** Stops a plugin and removes its installed code, keeping the folder it writes to. */
    async uninstall(options: { fs: FileSystemContext; name: string }): Promise<UninstalledPlugin> {
        this.#assertOpen();
        const discovery = await discoverPlugins(this.directory);
        const wanted = options.name.trim().toLowerCase();
        const installed = discovery.plugins.find(
            (plugin) =>
                plugin.manifest.name.toLowerCase() === wanted ||
                plugin.folderName.toLowerCase() === wanted,
        );
        if (installed === undefined) {
            const known = discovery.plugins.map((plugin) => plugin.manifest.name);
            throw new Error(
                known.length === 0
                    ? `No plugin named ${options.name} is installed. No plugins are installed.`
                    : `No plugin named ${options.name} is installed. Installed plugins: ${known.join(", ")}.`,
            );
        }
        await this.#stopRunning(installed.folderName);
        await options.fs.rm(join(this.directory, installed.folderName), {
            force: true,
            recursive: true,
        });
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
    async list(): Promise<{
        failures: readonly { error: string; folder: string }[];
        plugins: readonly PluginSummary[];
    }> {
        const discovery = await discoverPlugins(this.directory);
        return {
            failures: discovery.failures.map((failure) => ({
                error: failure.error,
                folder: failure.folderName,
            })),
            plugins: discovery.plugins.map((plugin) => ({
                dataDirectory: getPluginDataDirectory(plugin.folderName, this.#environment),
                description: plugin.manifest.description,
                directory: plugin.directory,
                folder: plugin.folderName,
                name: plugin.manifest.name,
                running: this.#running.has(plugin.folderName),
            })),
        };
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await Promise.all([...this.#running.values()].map((plugin) => plugin.close()));
        this.#running.clear();
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
                ...(this.#defaultDocker === undefined
                    ? {}
                    : { defaultDocker: this.#defaultDocker }),
                environment: this.#environment,
                store: this.#store,
            });
            if (this.#closed) {
                await running.close();
                return;
            }
            this.#running.set(folderName, running);
            this.#daemonLog.record("info", "plugin_started", `The ${name} plugin started.`, {
                dataDirectory: running.dataDirectory,
                logPath: running.logPath,
                pid: running.pid,
                plugin: name,
                pluginDirectory: directory,
            });
            void running.completion.then(
                ({ code, signal }) => {
                    this.#forgetExited(folderName, running);
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
                    this.#forgetExited(folderName, running);
                    this.#daemonLog.record(
                        "error",
                        "plugin_process_failed",
                        `The ${name} plugin process failed.`,
                        { error: errorToMessage(error), plugin: name },
                    );
                },
            );
        } catch (error) {
            this.#daemonLog.record(
                "error",
                "plugin_start_failed",
                `Rig could not start the ${name} plugin.`,
                { error: errorToMessage(error), plugin: name, pluginDirectory: directory },
            );
        }
    }

    async #stopRunning(folderName: string): Promise<void> {
        const running = this.#running.get(folderName);
        if (running === undefined) return;
        this.#running.delete(folderName);
        await running.close();
    }

    /** A plugin that ends on its own leaves the running set, and clients see it stop. */
    #forgetExited(folderName: string, running: RunningPlugin): void {
        if (this.#running.get(folderName) !== running) return;
        this.#running.delete(folderName);
        void this.#publishChanged();
    }

    async #publishChanged(): Promise<void> {
        if (this.#closed) return;
        let plugins: readonly PluginSummary[];
        try {
            ({ plugins } = await this.list());
        } catch (error) {
            this.#daemonLog.record(
                "warning",
                "plugins_unreadable",
                "Rig could not read the plugins folder to announce a change.",
                { error: errorToMessage(error) },
            );
            return;
        }
        const event = {
            createdAt: this.#now(),
            data: { plugins },
            id: this.#createEventId(),
            type: "plugins_changed" as const,
        };
        this.#store.globalEventQueue.publishLive(event);
        this.#store.liveEvents.publish(event);
    }
}
