import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { DaemonLog } from "../server/DaemonLog.js";
import { discoverPlugins } from "./discoverPlugins.js";
import { getPluginsDirectory } from "./getPluginsDirectory.js";
import { startPlugin, type RunningPlugin } from "./startPlugin.js";

export interface PluginManagerOptions {
    daemonLog: DaemonLog;
    defaultDocker?: DockerExecutionConfig;
    directory?: string;
    environment?: NodeJS.ProcessEnv;
    store: SessionStore;
}

export class PluginManager {
    readonly directory: string;

    readonly #daemonLog: DaemonLog;
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #running: RunningPlugin[] = [];
    readonly #store: SessionStore;
    #closed = false;
    #started = false;

    constructor(options: PluginManagerOptions) {
        this.#daemonLog = options.daemonLog;
        this.#defaultDocker = options.defaultDocker;
        this.#environment = options.environment ?? process.env;
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
            try {
                const running = await startPlugin(plugin, {
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
                this.#running.push(running);
                this.#daemonLog.record(
                    "info",
                    "plugin_started",
                    `The ${plugin.manifest.name} plugin started.`,
                    {
                        dataDirectory: running.dataDirectory,
                        logPath: running.logPath,
                        pid: running.pid,
                        plugin: plugin.manifest.name,
                        pluginDirectory: plugin.directory,
                    },
                );
                void running.completion.then(
                    ({ code, signal }) => {
                        this.#daemonLog.record(
                            code === 0 ? "info" : "warning",
                            "plugin_exited",
                            `The ${plugin.manifest.name} plugin exited.`,
                            {
                                ...(code === null ? {} : { exitCode: code }),
                                plugin: plugin.manifest.name,
                                ...(signal === null ? {} : { signal }),
                            },
                        );
                    },
                    (error: unknown) => {
                        this.#daemonLog.record(
                            "error",
                            "plugin_process_failed",
                            `The ${plugin.manifest.name} plugin process failed.`,
                            {
                                error: errorToMessage(error),
                                plugin: plugin.manifest.name,
                            },
                        );
                    },
                );
            } catch (error) {
                this.#daemonLog.record(
                    "error",
                    "plugin_start_failed",
                    `Rig could not start the ${plugin.manifest.name} plugin.`,
                    {
                        error: errorToMessage(error),
                        plugin: plugin.manifest.name,
                        pluginDirectory: plugin.directory,
                    },
                );
            }
        }
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await Promise.all(this.#running.map((plugin) => plugin.close()));
        this.#running.length = 0;
    }
}
