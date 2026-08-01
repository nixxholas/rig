import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { DaemonLog } from "../server/DaemonLog.js";
import { discoverExtensions } from "./discoverExtensions.js";
import { getExtensionsDirectory } from "./getExtensionsDirectory.js";
import { startExtension, type RunningExtension } from "./startExtension.js";

export interface ExtensionManagerOptions {
    daemonLog: DaemonLog;
    defaultDocker?: DockerExecutionConfig;
    directory?: string;
    environment?: NodeJS.ProcessEnv;
    store: SessionStore;
}

export class ExtensionManager {
    readonly directory: string;

    readonly #daemonLog: DaemonLog;
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #running: RunningExtension[] = [];
    readonly #store: SessionStore;
    #closed = false;
    #started = false;

    constructor(options: ExtensionManagerOptions) {
        this.#daemonLog = options.daemonLog;
        this.#defaultDocker = options.defaultDocker;
        this.#environment = options.environment ?? process.env;
        this.#store = options.store;
        this.directory = options.directory ?? getExtensionsDirectory(this.#environment);
    }

    async start(): Promise<void> {
        if (this.#started) return;
        this.#started = true;
        const discovery = await discoverExtensions(this.directory);
        for (const failure of discovery.failures) {
            this.#daemonLog.record(
                "error",
                "extension_registration_failed",
                `Rig could not register the extension in ${failure.folderName}.`,
                {
                    directory: failure.directory,
                    error: failure.error,
                    extensionFolder: failure.folderName,
                },
            );
        }
        for (const extension of discovery.extensions) {
            if (this.#closed) return;
            try {
                const running = await startExtension(extension, {
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
                    "extension_started",
                    `The ${extension.manifest.name} extension started.`,
                    {
                        extension: extension.manifest.name,
                        extensionDirectory: extension.directory,
                        logPath: running.logPath,
                        pid: running.pid,
                    },
                );
                void running.completion.then(
                    ({ code, signal }) => {
                        this.#daemonLog.record(
                            code === 0 ? "info" : "warning",
                            "extension_exited",
                            `The ${extension.manifest.name} extension exited.`,
                            {
                                ...(code === null ? {} : { exitCode: code }),
                                extension: extension.manifest.name,
                                ...(signal === null ? {} : { signal }),
                            },
                        );
                    },
                    (error: unknown) => {
                        this.#daemonLog.record(
                            "error",
                            "extension_process_failed",
                            `The ${extension.manifest.name} extension process failed.`,
                            {
                                error: errorToMessage(error),
                                extension: extension.manifest.name,
                            },
                        );
                    },
                );
            } catch (error) {
                this.#daemonLog.record(
                    "error",
                    "extension_start_failed",
                    `Rig could not start the ${extension.manifest.name} extension.`,
                    {
                        error: errorToMessage(error),
                        extension: extension.manifest.name,
                        extensionDirectory: extension.directory,
                    },
                );
            }
        }
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await Promise.all(this.#running.map((extension) => extension.close()));
        this.#running.length = 0;
    }
}
