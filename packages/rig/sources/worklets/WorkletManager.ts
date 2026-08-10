import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@steve.kite/stdlib";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { errorToMessage } from "../errorToMessage.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import type { EventId } from "../protocol/EventId.js";
import type {
    InstallWorkletRequest,
    RevertWorkletRequest,
    UpdateWorkletRequest,
    Worklet,
    WorkletState,
    WorkletTool,
    WorkletsChangedEvent,
} from "../protocol/WorkletProtocol.js";
import type { StoredWorklet } from "../persistence/worklets/queryWorklets.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { getWorkletRuntimeDirectory } from "./getWorkletRuntimeDirectory.js";
import { readBoundedWorkletLog } from "./readBoundedWorkletLog.js";
import type { WorkletIconFileResult, WorkletIconFormat } from "./readWorkletIcon.js";
import { startWorklet, type RunningWorklet } from "./startWorklet.js";
import type { WorkletSourceReader } from "./copyWorkletSource.js";
import { WorkletNotFoundError } from "./WorkletNotFoundError.js";
import { DEFAULT_WORKLET_STARTUP_TIMEOUT_MS } from "./WorkletStartupState.js";
import type { ExpectedWorkletDeclaration, WorkletStore } from "./WorkletStore.js";
import type { WorkletToolRegistry } from "./WorkletToolRegistry.js";
import { withWorkerContext } from "../observability/index.js";

interface WorkletRuntime {
    failure?: string;
    running?: RunningWorklet;
    state: WorkletState;
    status?: string;
    /**
     * Set when this runtime has been stopped, so a launch that was still starting up at the time
     * closes the process it produced instead of leaving it running with nothing pointing at it.
     */
    stopped?: boolean;
    tools: readonly WorkletTool[];
}

export interface WorkletManagerOptions {
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    /** Delivers a change to the live global stream. */
    publish: (ctx: Context, event: WorkletsChangedEvent) => void;
    registry: WorkletToolRegistry;
    /** How long a worklet has to declare its tools and report ready. */
    startupTimeoutMs?: number;
    store: WorkletStore;
}

/**
 * The daemon lifecycle boundary for worklets.
 *
 * The store owns the catalog and the folders; this owns the processes. Every worklet starts
 * concurrently, gets one bounded window to declare its tools and report ready, and publishes the
 * whole current set on every change, so a client never polls and never waits for a restart.
 */
export class WorkletManager {
    readonly #createEventId = createEventIdFactory();
    readonly #environment: NodeJS.ProcessEnv;
    readonly #now: () => number;
    readonly #pendingPublications = new Set<Promise<void>>();
    #publicationTail = Promise.resolve();
    readonly #publish: (ctx: Context, event: WorkletsChangedEvent) => void;
    readonly #registry: WorkletToolRegistry;
    readonly #runtimes = new Map<string, WorkletRuntime>();
    readonly #lifecycleByName = new Map<string, Promise<void>>();
    readonly #startupTimeoutMs: number;
    readonly #store: WorkletStore;
    #closed = false;
    #version: EventId;

    constructor(options: WorkletManagerOptions) {
        this.#environment = options.environment ?? process.env;
        this.#now = options.now ?? Date.now;
        this.#publish = options.publish;
        this.#registry = options.registry;
        this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_WORKLET_STARTUP_TIMEOUT_MS;
        this.#store = options.store;
        this.#version = this.#createEventId();
    }

    get directory(): string {
        return this.#store.directory;
    }

    /** Launches every installed worklet at once and resolves when all of them have settled. */
    async start(ctx: Context): Promise<void> {
        await this.#store.cleanupStaging(ctx);
        const installed = await this.#store.list(ctx);
        await Promise.all(
            installed.map((worklet) =>
                this.#serializeLifecycle(worklet.name, () => this.#launch(ctx, worklet)),
            ),
        );
        await this.#publishChanged(ctx);
    }

    async list(ctx: Context): Promise<readonly Worklet[]> {
        return (await this.#store.list(ctx)).map((worklet) => this.#present(worklet));
    }

    /** The current worklets together with the change they reflect. */
    async catalog(ctx: Context): Promise<{ version: EventId; worklets: readonly Worklet[] }> {
        return { version: this.#version, worklets: await this.list(ctx) };
    }

    async get(ctx: Context, name: string): Promise<Worklet | undefined> {
        const stored = await this.#store.get(ctx, name);
        return stored === undefined ? undefined : this.#present(stored);
    }

    async install(
        ctx: Context,
        request: InstallWorkletRequest,
        sourceFileSystem?: FileSystemContext | WorkletSourceReader,
        expected: ExpectedWorkletDeclaration = {},
    ): Promise<Worklet> {
        // The first read discovers only which lifecycle queue owns the operation. The store copies
        // and validates an immutable snapshot again inside that queue before committing anything.
        const inspected = await this.#store.inspect(ctx, request.path, sourceFileSystem);
        return this.#serializeLifecycle(inspected.name, async () => {
            const stored = await this.#store.install(ctx, request, sourceFileSystem, {
                ...expected,
                name: inspected.name,
            });
            await this.#launch(ctx, stored);
            await this.#publishChanged(ctx);
            return this.#present(stored);
        });
    }

    async update(
        ctx: Context,
        name: string,
        request: UpdateWorkletRequest,
        sourceFileSystem?: FileSystemContext | WorkletSourceReader,
        expected: ExpectedWorkletDeclaration = {},
    ): Promise<Worklet> {
        return this.#serializeLifecycle(name, async () => {
            const stored = await this.#store.update(ctx, name, request, sourceFileSystem, expected);
            await this.#stop(name, "The worklet was replaced.");
            await this.#launch(ctx, stored);
            await this.#publishChanged(ctx);
            return this.#present(stored);
        });
    }

    async revert(
        ctx: Context,
        name: string,
        request: RevertWorkletRequest,
        expected: ExpectedWorkletDeclaration = {},
    ): Promise<Worklet> {
        return this.#serializeLifecycle(name, async () => {
            const stored = await this.#store.revert(ctx, name, request, expected);
            await this.#stop(name, "The worklet was replaced.");
            await this.#launch(ctx, stored);
            await this.#publishChanged(ctx);
            return this.#present(stored);
        });
    }

    async uninstall(ctx: Context, name: string): Promise<void> {
        await this.#serializeLifecycle(name, async () => {
            await this.#stop(name);
            try {
                await this.#store.remove(ctx, name);
                // The runtime folder is Rig's own, so it goes with the worklet rather than
                // outliving it the way the worklet's data folder does.
                await rm(getWorkletRuntimeDirectory(name, this.#environment), {
                    force: true,
                    recursive: true,
                });
            } catch (error) {
                if ((await this.#store.get(ctx, name)) === undefined) this.#runtimes.delete(name);
                await this.#publishChanged(ctx);
                throw error;
            }
            this.#runtimes.delete(name);
            await this.#publishChanged(ctx);
        });
    }

    async readIcon(
        ctx: Context,
        name: string,
        format: WorkletIconFormat,
    ): Promise<WorkletIconFileResult> {
        return this.#store.readIcon(ctx, name, format);
    }

    async readLog(ctx: Context, name: string): Promise<{ log: string; truncated: boolean }> {
        if ((await this.#store.get(ctx, name)) === undefined) {
            throw new WorkletNotFoundError(`No worklet named ${JSON.stringify(name)} exists.`);
        }
        const runtime = this.#runtimes.get(name);
        const bounded = await readBoundedWorkletLog(this.#logPath(name));
        if (bounded.text.length > 0) return { log: bounded.text, truncated: bounded.truncated };
        if (runtime?.failure !== undefined) {
            return { log: runtime.failure, truncated: false };
        }
        return { log: "", truncated: false };
    }

    async close(_ctx: Context): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await Promise.allSettled(
            [...this.#runtimes.keys()].map((name) =>
                this.#serializeLifecycle(name, () => this.#stop(name, "Rig shut down.")),
            ),
        );
        await Promise.allSettled([this.#publicationTail, ...this.#pendingPublications]);
        await this.#registry.close();
    }

    #logPath(name: string): string {
        return join(this.#store.directory, name, "worklet.log");
    }

    /**
     * Runs one worklet's lifecycle steps in order.
     *
     * Starting and stopping a process are not atomic, so two of them overlapping is how a stop
     * ends up killing nothing and a launched process outlives everything pointing at it. Each
     * worklet's steps therefore queue behind one another; different worklets stay independent.
     */
    async #serializeLifecycle<T>(name: string, work: () => Promise<T>): Promise<T> {
        const previous = this.#lifecycleByName.get(name) ?? Promise.resolve();
        let result!: Promise<T>;
        const queued = previous.then(() => {
            result = work();
            return result.then(
                () => undefined,
                () => undefined,
            );
        });
        this.#lifecycleByName.set(name, queued);
        try {
            await queued;
            return await result;
        } finally {
            if (this.#lifecycleByName.get(name) === queued) this.#lifecycleByName.delete(name);
        }
    }

    async #launch(ctx: Context, worklet: StoredWorklet): Promise<void> {
        if (this.#closed) return;
        const runtime: WorkletRuntime = { state: "starting", tools: [] };
        this.#runtimes.set(worklet.name, runtime);
        let running: RunningWorklet;
        try {
            running = await startWorklet(ctx, {
                dataDirectory: this.#store.dataDirectory(worklet.name),
                environment: this.#environment,
                logPath: this.#logPath(worklet.name),
                name: worklet.name,
                onStatus: (status) => {
                    runtime.status = status;
                    this.#publishChangedInBackground();
                },
                onToolsRetired: (reason) => {
                    void withWorkerContext(
                        "worklet-tools-retired",
                        (ctx) =>
                            this.#serializeLifecycle(worklet.name, async () => {
                                // A retirement notification belongs to this exact generation. If an
                                // update or revert replaced it while the notification waited in the
                                // lifecycle queue, it must not stop the replacement.
                                if (this.#runtimes.get(worklet.name) !== runtime) return;
                                await this.#stop(worklet.name, reason);
                                await this.#publishChanged(ctx);
                            }),
                        { workletName: worklet.name },
                    ).catch(rethrowDatabaseFailure);
                },
                permissions: worklet.permissions,
                registry: this.#registry,
                runtimeDirectory: getWorkletRuntimeDirectory(worklet.name, this.#environment),
                versionDirectory: this.#store.versionDirectory(
                    worklet.name,
                    worklet.currentVersion,
                ),
            });
        } catch (error) {
            runtime.state = "failed";
            runtime.failure = errorToMessage(error);
            return;
        }
        // Nothing was holding this process while it started, so a stop or a replacement that
        // arrived in the meantime is honoured now rather than leaving the child orphaned.
        if (runtime.stopped === true || this.#runtimes.get(worklet.name) !== runtime) {
            await running.close({ force: true });
            return;
        }
        runtime.running = running;
        const settled = await Promise.race([
            running.startup.settled,
            running.completion.then(
                () =>
                    ({
                        error: "The worklet stopped before it reported ready.",
                        status: "failed",
                    }) as const,
                (error: unknown) => ({ error: errorToMessage(error), status: "failed" }) as const,
            ),
            new Promise<{ error: string; status: "failed" }>((resolve) => {
                const timer = setTimeout(
                    () =>
                        resolve({
                            error: `The worklet did not report ready within ${String(Math.round(this.#startupTimeoutMs / 1000))} seconds.`,
                            status: "failed",
                        }),
                    this.#startupTimeoutMs,
                );
                timer.unref();
            }),
        ]);
        if (settled.status === "failed") {
            running.startup.fail(settled.error);
            runtime.state = "failed";
            runtime.failure = settled.error;
            if (running.statusMessage !== undefined) runtime.status = running.statusMessage;
            await running.close({ force: true });
            delete runtime.running;
            return;
        }
        runtime.state = "running";
        runtime.tools = running.tools.declared();
        if (running.statusMessage !== undefined) runtime.status = running.statusMessage;
        // A worklet that exits on its own is news the interface needs without a restart.
        void running.completion
            .then(
                (result) =>
                    result.code === 0
                        ? undefined
                        : `The worklet exited with ${result.signal ?? `code ${String(result.code ?? 0)}`}.`,
                (error: unknown) => errorToMessage(error),
            )
            .then((failure) => {
                void withWorkerContext(
                    "worklet-exit",
                    async (ctx) => {
                        if (this.#runtimes.get(worklet.name) !== runtime) return;
                        runtime.state = failure === undefined ? "stopped" : "failed";
                        if (failure !== undefined) runtime.failure = failure;
                        runtime.tools = [];
                        delete runtime.running;
                        await this.#publishChanged(ctx);
                    },
                    { workletName: worklet.name },
                ).catch(rethrowDatabaseFailure);
            });
    }

    async #stop(name: string, reason?: string): Promise<void> {
        const runtime = this.#runtimes.get(name);
        const running = runtime?.running;
        if (runtime === undefined) return;
        delete runtime.running;
        runtime.stopped = true;
        runtime.state = "stopped";
        runtime.tools = [];
        if (reason !== undefined) runtime.failure = reason;
        await running?.close();
    }

    #present(worklet: StoredWorklet): Worklet {
        const runtime = this.#runtimes.get(worklet.name);
        return {
            ...worklet,
            versions: [...worklet.versions],
            dataDirectory: this.#store.dataDirectory(worklet.name),
            state: runtime?.state ?? "stopped",
            ...(runtime?.status === undefined ? {} : { status: runtime.status }),
            ...(runtime?.failure === undefined || runtime.state === "running"
                ? {}
                : { failure: runtime.failure }),
            tools: [...(runtime?.tools ?? [])],
        };
    }

    #publishChanged(ctx: Context): Promise<void> {
        const publication = this.#publicationTail
            .catch(() => undefined)
            .then(async () => {
                if (this.#closed) return;
                this.#version = this.#createEventId();
                const worklets = await this.list(ctx);
                this.#publish(ctx, {
                    createdAt: this.#now(),
                    data: { version: this.#version, worklets },
                    id: this.#createEventId(),
                    type: "worklets_changed",
                });
            });
        this.#publicationTail = publication;
        return publication;
    }

    /**
     * Status callbacks are synchronous, but publishing their catalog snapshots reads SQLite.
     * Track those reads so shutdown drains work already admitted before the database closes.
     */
    #publishChangedInBackground(): void {
        if (this.#closed) return;
        const publication = withWorkerContext("worklet-publish", (ctx) =>
            this.#publishChanged(ctx),
        );
        this.#pendingPublications.add(publication);
        void publication
            .finally(() => {
                this.#pendingPublications.delete(publication);
            })
            .catch(rethrowDatabaseFailure);
    }
}
