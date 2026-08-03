import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Dockerode from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { FileSystemContext } from "../../agent/context/FileSystemContext.js";
import type { LiveGlobalEventEntry } from "../../global-event/LiveGlobalEventQueue.js";
import type { ComputePreparationEvent, PluginsChangedEvent } from "../../protocol/index.js";
import { DaemonLog } from "../../server/DaemonLog.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { PluginManager } from "../PluginManager.js";
import { PluginComputeRegistry } from "../PluginComputeRegistry.js";
import { PluginMcpRegistry, type PluginMcpRegistrationRetirement } from "../PluginMcpRegistry.js";
import { DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS, PluginStartupState } from "../PluginStartupState.js";
import { MAXIMUM_PLUGIN_LOG_READ_BYTES } from "../readBoundedPluginLog.js";
import type { RegisteredPlugin } from "../types.js";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("plugin registration", () => {
    it("uses one ten-second startup window", () => {
        expect(DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS).toBe(10_000);
    });

    it("keeps the first startup terminal transition authoritative", async () => {
        const startup = new PluginStartupState();

        startup.ready();

        expect(startup.fail("The deadline fired too late.")).toBe(false);
        await expect(startup.settled).resolves.toEqual({ status: "running" });
        expect(() => startup.ready()).toThrow(
            "Plugin readiness was already reported for this plugin generation.",
        );
    });

    it("starts a plugin as it is installed and stops it as it is uninstalled", async () => {
        const harness = await createHarness();

        await harness.manager.start();
        expect(await harness.manager.list()).toMatchObject({ failures: [], plugins: [] });
        expect(harness.events).toHaveLength(1);

        await createPluginSource(join(harness.workspace, "clock"));
        const installed = await harness.manager.install({
            fs: harness.fs,
            sourceDirectory: join(harness.workspace, "clock"),
        });
        expect(installed).toMatchObject({
            classification: "fresh-install",
            folder: "clock",
            name: "Clock",
            version: "0.0.0",
        });

        // The plugin is registered and running by the time install resolves.
        const afterInstall = await harness.manager.list();
        expect(afterInstall.plugins).toEqual([
            {
                apps: [],
                dataDirectory: join(harness.dataRoot, "clock"),
                description: "A small clock.",
                directory: installed.directory,
                folder: "clock",
                logAvailable: true,
                name: "Clock",
                status: "running",
                statusMessage: "Ready.",
                version: "0.0.0",
            },
        ]);
        expect(lastPlugins(harness.events)).toEqual(afterInstall.plugins);
        expect(harness.events.at(-1)?.data.installation).toEqual(installed);
        expect(harness.started).toEqual(["Clock"]);
        expect(harness.stopped).toEqual([]);
        harness.store.slots.create({
            author: { folder: "clock", name: "Clock", type: "plugin" },
            content: { markdown: "Tick", type: "text" },
            description: "Clock status",
            purpose: "Show the plugin's current state",
            scope: "everywhere",
            slot: "status-line",
        });
        const retainedEntry = harness.store.slots.create({
            author: { folder: "calendar", name: "Calendar", type: "plugin" },
            content: { markdown: "Today", type: "text" },
            description: "Calendar status",
            purpose: "Verify uninstall cleanup stays selective",
            scope: "everywhere",
            slot: "status-line",
        });
        expect(harness.store.slots.list()).toHaveLength(2);
        await expect(harness.manager.readLog("Clock")).resolves.toMatchObject({
            source: "current_run",
            status: "running",
            text: "[stdout] ready\n",
        });
        harness.setStatus("Clock", "Waiting for the next tick.");
        await vi.waitFor(async () => {
            await expect(harness.manager.list()).resolves.toMatchObject({
                plugins: [{ statusMessage: "Waiting for the next tick." }],
            });
        });

        const uninstalled = await harness.manager.uninstall({ fs: harness.fs, name: "Clock" });
        expect(uninstalled).toEqual({
            dataDirectory: join(harness.dataRoot, "clock"),
            folder: "clock",
            name: "Clock",
        });
        expect(await harness.manager.list()).toMatchObject({ plugins: [] });
        expect(lastPlugins(harness.events)).toEqual([]);
        // The process stops before its code is removed, and is not started again.
        expect(harness.stopped).toEqual(["Clock"]);
        expect(harness.started).toEqual(["Clock"]);
        expect(harness.store.slots.list()).toEqual([retainedEntry]);
    });

    it("announces every registration change on the live event stream", async () => {
        const harness = await createHarness();
        await harness.manager.start();
        await createPluginSource(join(harness.workspace, "clock"));

        await harness.manager.install({
            fs: harness.fs,
            sourceDirectory: join(harness.workspace, "clock"),
        });
        await harness.manager.uninstall({ fs: harness.fs, name: "Clock" });

        // Startup, install, and uninstall each announce the whole current set.
        expect(harness.events.map((event) => event.data.plugins.length)).toEqual([0, 1, 0]);
        for (const event of harness.events) {
            expect(event.type).toBe("plugins_changed");
            expect(event.id).toEqual(expect.any(String));
            expect(event.createdAt).toEqual(expect.any(Number));
        }
        expect(new Set(harness.events.map((event) => event.id)).size).toBe(harness.events.length);
    });

    it("announces compute provider health and disappearance through plugins_changed", async () => {
        const computeRegistry = new PluginComputeRegistry();
        const harness = await createHarness({ computeRegistry });
        await harness.manager.start();
        await createPluginSource(
            join(harness.workspace, "cloud"),
            undefined,
            "Cloud",
            undefined,
            "cloud",
        );
        await harness.manager.install({
            fs: harness.fs,
            sourceDirectory: join(harness.workspace, "cloud"),
        });
        const provider = computeRegistry.createConnection({
            compute: { name: "cloud" },
            folder: "cloud",
            name: "Cloud",
        });
        const consumer = computeRegistry.createConnection({
            folder: "consumer",
            name: "Consumer",
        });
        const registrationId = provider.register();
        const detach = provider.attach(registrationId, (event) => {
            if (event.type === "call" && event.operation === "start") {
                provider.complete(registrationId, event.callId, {
                    error: {
                        code: "invalid_response",
                        message: "Cloud refused the sandbox.",
                        retryable: false,
                    },
                });
            }
            return true;
        });
        await vi.waitFor(() =>
            expect(harness.events.at(-1)?.data.plugins[0]?.compute).toEqual({
                health: "healthy",
                name: "cloud",
                provisioningTimeoutMs: 300_000,
            }),
        );

        const instance = computeRegistry.create(
            {
                provider: "cloud",
                workspaceSource: {
                    path: "/source",
                    type: "local_directory",
                },
            },
            consumer.generation,
        );
        for (let failure = 0; failure < 2; failure += 1) {
            await expect(
                computeRegistry.read(
                    { instanceId: instance.instanceId, path: "message.txt" },
                    consumer.generation,
                ),
            ).rejects.toMatchObject({ code: "preparing_compute" });
            await vi.waitFor(() =>
                expect(computeRegistry.listInstances(consumer.generation)[0]?.state).toBe(
                    "unprovisioned",
                ),
            );
        }
        await vi.waitFor(() =>
            expect(harness.events.at(-1)?.data.plugins[0]?.compute).toEqual({
                health: "degraded",
                name: "cloud",
                provisioningTimeoutMs: 300_000,
            }),
        );
        expect(harness.computeEvents.map((event) => event.data.phase)).toEqual([
            "preparing_compute",
            "failed",
            "preparing_compute",
            "failed",
        ]);
        expect(
            harness.store.globalEventQueue
                .list()
                ?.filter((entry) => entry.event.type === "compute_preparation")
                .map((entry) => entry.event.id),
        ).toEqual(harness.computeEvents.map((event) => event.id));

        detach();
        await vi.waitFor(() =>
            expect(harness.events.at(-1)?.data.plugins[0]?.compute).toEqual({
                health: "failed",
                name: "cloud",
                provisioningTimeoutMs: 300_000,
            }),
        );
        provider.close();
        await vi.waitFor(() =>
            expect(harness.events.at(-1)?.data.plugins[0]?.compute).toBeUndefined(),
        );
        consumer.close();
    });

    it("durably closes an in-flight preparation before daemon shutdown", async () => {
        const computeRegistry = new PluginComputeRegistry();
        const harness = await createHarness({ computeRegistry });
        await harness.manager.start();
        const provider = computeRegistry.createConnection({
            compute: { name: "cloud" },
            folder: "cloud",
            name: "Cloud",
        });
        const consumer = computeRegistry.createConnection({
            folder: "consumer",
            name: "Consumer",
        });
        const registrationId = provider.register();
        provider.attach(registrationId, () => true);
        const instance = computeRegistry.create(
            {
                provider: "cloud",
                workspaceSource: { path: "/source", type: "local_directory" },
            },
            consumer.generation,
        );

        await expect(
            computeRegistry.read(
                { instanceId: instance.instanceId, path: "message.txt" },
                consumer.generation,
            ),
        ).rejects.toMatchObject({ code: "preparing_compute" });
        await vi.waitFor(() =>
            expect(harness.computeEvents.map((event) => event.data.phase)).toEqual([
                "preparing_compute",
            ]),
        );

        await harness.manager.close();

        expect(harness.computeEvents.map((event) => event.data.phase)).toEqual([
            "preparing_compute",
            "stopped",
        ]);
        expect(harness.computeEvents.at(-1)?.data).toMatchObject({
            state: "stopped",
        });
        expect(
            harness.store.globalEventQueue
                .list()
                ?.filter((entry) => entry.event.type === "compute_preparation")
                .map((entry) => entry.event.id),
        ).toEqual(harness.computeEvents.map((event) => event.id));
    });

    it("completes install and uninstall when Docker housekeeping fails", async () => {
        const docker = {
            getImage: () => ({ inspect: async () => ({}) }),
            listContainers: async () => Promise.reject(new Error("Docker stopped responding.")),
            listImages: async () => Promise.reject(new Error("Docker stopped responding.")),
        } as unknown as Dockerode;
        const harness = await createHarness({ docker });
        await harness.manager.start();
        const source = join(harness.workspace, "docker-clock");
        await createPluginSource(source, undefined, "Docker Clock", {
            image: "example.invalid/docker-clock:1.0.0",
        });

        const installed = await harness.manager.install({
            fs: harness.fs,
            sourceDirectory: source,
        });

        expect(harness.events.at(-1)?.data.installation).toEqual(installed);
        await expect(harness.manager.list()).resolves.toMatchObject({
            plugins: [{ name: "Docker Clock", status: "running" }],
        });

        await expect(
            harness.manager.uninstall({ fs: harness.fs, name: "Docker Clock" }),
        ).resolves.toMatchObject({ folder: "docker-clock", name: "Docker Clock" });
        await expect(access(installed.directory)).rejects.toMatchObject({ code: "ENOENT" });
        expect(lastPlugins(harness.events)).toEqual([]);
    });

    it("announces an upgrade classification with the new catalog version", async () => {
        const harness = await createHarness();
        await harness.manager.start();
        const source = join(harness.workspace, "clock");
        await createPluginSource(source, "1.0.0");
        await harness.manager.install({ fs: harness.fs, sourceDirectory: source });
        await createPluginSource(source, "2.0.0");

        const installed = await harness.manager.install({
            fs: harness.fs,
            sourceDirectory: source,
        });

        expect(installed).toMatchObject({ classification: "upgrade", version: "2.0.0" });
        expect(harness.events.at(-1)?.data.installation).toEqual(installed);
        await expect(harness.manager.list()).resolves.toMatchObject({
            plugins: [{ version: "2.0.0" }],
        });
    });

    it("keeps a running plugin when a replacement has no main entry point", async () => {
        const harness = await createHarness();
        await harness.manager.start();
        const source = join(harness.workspace, "clock");
        await createPluginSource(source);
        await harness.manager.install({ fs: harness.fs, sourceDirectory: source });

        await rm(join(source, "index.ts"));
        await expect(
            harness.manager.install({ fs: harness.fs, sourceDirectory: source }),
        ).rejects.toThrow('The plugin main entry point "index.ts" does not exist.');

        const listed = await harness.manager.list();
        expect(listed.plugins).toMatchObject([{ name: "Clock", status: "running" }]);
        expect(harness.stopped).toEqual([]);
    });

    it("refuses to uninstall a plugin that is not installed", async () => {
        const harness = await createHarness();
        await harness.manager.start();

        await expect(harness.manager.uninstall({ fs: harness.fs, name: "Clock" })).rejects.toThrow(
            "No plugins are installed.",
        );
    });

    it("stops changing plugins once Rig is shutting down", async () => {
        const harness = await createHarness();
        await harness.manager.start();
        await harness.manager.close();

        await expect(
            harness.manager.install({ fs: harness.fs, sourceDirectory: harness.workspace }),
        ).rejects.toThrow("shutting down");
    });

    it("exposes bounded startup diagnostics as an explicit failed state", async () => {
        const diagnostics = `${"x".repeat(
            MAXIMUM_PLUGIN_LOG_READ_BYTES,
        )}\nThe plugin runtime could not start.`;
        const harness = await createHarness({
            startError: new Error(diagnostics),
        });
        await createPluginSource(join(harness.manager.directory, "broken"));

        await harness.manager.start();

        expect(await harness.manager.list()).toMatchObject({
            plugins: [
                {
                    error: expect.stringContaining("The plugin runtime could not start."),
                    logAvailable: true,
                    status: "failed",
                },
            ],
        });
        const log = await harness.manager.readLog("Broken");
        expect(log).toMatchObject({
            source: "error",
            status: "failed",
            text: expect.stringContaining("The plugin runtime could not start."),
            truncated: true,
        });
        expect(Buffer.byteLength(log.text)).toBe(MAXIMUM_PLUGIN_LOG_READ_BYTES);
    });

    it("reports startup failures as failed", async () => {
        const harness = await createHarness({
            startError: new Error("The sandbox did not start."),
        });
        await createPluginSource(join(harness.manager.directory, "broken"));

        await harness.manager.start();

        expect(await harness.manager.list()).toMatchObject({
            plugins: [{ error: "The sandbox did not start.", status: "failed" }],
        });
        await expect(harness.manager.readLog("Broken")).resolves.toMatchObject({
            error: "The sandbox did not start.",
            source: "error",
            status: "failed",
        });
    });

    it("starts plugins concurrently and times out only the generation that never reports ready", async () => {
        const harness = await createHarness({
            startup(plugin, startup) {
                if (plugin.manifest.name === "Fast") startup.ready();
            },
            startupTimeoutMs: 25,
        });
        await Promise.all([
            createPluginSource(join(harness.manager.directory, "fast"), undefined, "Fast"),
            createPluginSource(join(harness.manager.directory, "slow"), undefined, "Slow"),
        ]);

        const starting = harness.manager.start();
        await vi.waitFor(() => {
            expect(harness.started).toHaveLength(2);
            expect(harness.started).toEqual(expect.arrayContaining(["Fast", "Slow"]));
        });
        await starting;

        await expect(harness.manager.list()).resolves.toMatchObject({
            plugins: [
                { name: "Fast", status: "running" },
                {
                    error: "The plugin did not report ready within 25 milliseconds.",
                    name: "Slow",
                    status: "failed",
                },
            ],
        });
        expect(harness.stopped).toEqual(["Slow"]);
    });

    it("includes process creation in the startup deadline and closes a late generation", async () => {
        const releaseStart = deferred<void>();
        const harness = await createHarness({
            beforeStart: async () => releaseStart.promise,
            startupTimeoutMs: 25,
        });
        await createPluginSource(join(harness.manager.directory, "slow"));

        await harness.manager.start();

        await expect(harness.manager.list()).resolves.toMatchObject({
            plugins: [
                {
                    error: "The plugin did not report ready within 25 milliseconds.",
                    status: "failed",
                },
            ],
        });
        releaseStart.resolve();
        await vi.waitFor(() => expect(harness.stopped).toEqual(["Clock"]));
    });

    it("does not let a closing startup generation write a terminal state afterward", async () => {
        const harness = await createHarness({
            startup() {},
            startupTimeoutMs: 10_000,
        });
        await createPluginSource(join(harness.manager.directory, "clock"));

        const starting = harness.manager.start();
        await vi.waitFor(() => expect(harness.started).toEqual(["Clock"]));
        await harness.manager.close();
        await starting;

        await expect(harness.manager.list()).resolves.toMatchObject({
            plugins: [{ name: "Clock", status: "stopped" }],
        });
        expect(harness.stopped).toEqual(["Clock"]);
    });

    it("fails and republishes a running generation whose MCP registration retires", async () => {
        const harness = await createHarness();
        await createPluginSource(join(harness.manager.directory, "clock"));
        await harness.manager.start();
        expect(harness.events).toHaveLength(1);

        harness.retireRuntime("Clock", {
            reason: "The plugin MCP connection closed.",
            status: "failed",
        });

        await vi.waitFor(async () => {
            await expect(harness.manager.list()).resolves.toMatchObject({
                plugins: [
                    {
                        error: "The plugin MCP connection closed.",
                        name: "Clock",
                        status: "failed",
                    },
                ],
            });
            expect(harness.events).toHaveLength(2);
        });
        expect(lastPlugins(harness.events)).toMatchObject([
            { error: "The plugin MCP connection closed.", status: "failed" },
        ]);
        expect(harness.stopped).toEqual(["Clock"]);
    });

    it("reports a clean process exit as stopped even when its MCP stream closes first", async () => {
        const harness = await createHarness();
        await createPluginSource(join(harness.manager.directory, "clock"));
        await harness.manager.start();

        harness.retireRuntime("Clock", {
            reason: "The plugin MCP connection closed.",
            status: "failed",
        });
        harness.exitRuntime("Clock");

        await vi.waitFor(async () => {
            await expect(harness.manager.list()).resolves.toMatchObject({
                plugins: [{ name: "Clock", status: "stopped" }],
            });
        });
        expect(harness.stopped).toEqual([]);
    });

    it("stops a running plugin that intentionally unregisters its MCP server", async () => {
        const harness = await createHarness();
        await createPluginSource(join(harness.manager.directory, "clock"));
        await harness.manager.start();

        harness.retireRuntime("Clock", {
            reason: "The plugin unregistered this MCP server.",
            status: "stopped",
        });

        await vi.waitFor(async () => {
            await expect(harness.manager.list()).resolves.toMatchObject({
                plugins: [{ name: "Clock", status: "stopped" }],
            });
        });
        expect(harness.stopped).toEqual(["Clock"]);
    });

    it("closes a stale startup generation without replacing the current state", async () => {
        const firstStart = deferred<void>();
        const releaseFirstStart = deferred<void>();
        const harness = await createHarness({
            async beforeStart(_plugin, attempt) {
                if (attempt !== 1) return;
                firstStart.resolve();
                await releaseFirstStart.promise;
            },
        });
        await createPluginSource(join(harness.manager.directory, "clock"), "1.0.0");
        const starting = harness.manager.start();
        await firstStart.promise;
        const source = join(harness.workspace, "clock");
        await createPluginSource(source, "2.0.0");

        await harness.manager.install({ fs: harness.fs, sourceDirectory: source });
        releaseFirstStart.resolve();
        await starting;

        await expect(harness.manager.list()).resolves.toMatchObject({
            plugins: [{ name: "Clock", status: "running", version: "2.0.0" }],
        });
        expect(harness.started).toEqual(["Clock", "Clock"]);
        expect(harness.stopped).toEqual(["Clock"]);
    });

    it("does not let a stale startup error overwrite the current generation", async () => {
        const firstStart = deferred<void>();
        const releaseFirstStart = deferred<void>();
        const harness = await createHarness({
            async beforeStart(_plugin, attempt) {
                if (attempt !== 1) return;
                firstStart.resolve();
                await releaseFirstStart.promise;
            },
            startError: (_plugin, attempt) =>
                attempt === 1 ? new Error("The stale generation failed.") : undefined,
        });
        await createPluginSource(join(harness.manager.directory, "clock"), "1.0.0");
        const starting = harness.manager.start();
        await firstStart.promise;
        const source = join(harness.workspace, "clock");
        await createPluginSource(source, "2.0.0");

        await harness.manager.install({ fs: harness.fs, sourceDirectory: source });
        releaseFirstStart.resolve();
        await starting;

        const listed = await harness.manager.list();
        expect(listed).toMatchObject({
            plugins: [{ status: "running", version: "2.0.0" }],
        });
        expect(listed.plugins[0]).not.toHaveProperty("error");
    });

    it("coalesces rapid status updates into one bounded catalog publication", async () => {
        const harness = await createHarness();
        await createPluginSource(join(harness.manager.directory, "clock"));
        await harness.manager.start();
        const publishedBeforeStatus = harness.events.length;

        harness.setStatus("Clock", "First.");
        harness.setStatus("Clock", "Second.");
        harness.setStatus("Clock", "Latest.");

        await vi.waitFor(() => expect(harness.events).toHaveLength(publishedBeforeStatus + 1));
        expect(lastPlugins(harness.events)).toMatchObject([{ statusMessage: "Latest." }]);
    });
});

function lastPlugins(events: readonly PluginsChangedEvent[]): unknown {
    return events.at(-1)?.data.plugins;
}

async function createHarness(
    options: {
        beforeStart?: (plugin: RegisteredPlugin, attempt: number) => Promise<void>;
        computeRegistry?: PluginComputeRegistry;
        docker?: Dockerode;
        dockerCleanupTimeoutMs?: number;
        startError?: Error | ((plugin: RegisteredPlugin, attempt: number) => Error | undefined);
        startup?: (plugin: RegisteredPlugin, startup: PluginStartupState) => void;
        startupTimeoutMs?: number;
    } = {},
): Promise<{
    computeEvents: ComputePreparationEvent[];
    dataRoot: string;
    events: PluginsChangedEvent[];
    exitRuntime(name: string): void;
    fs: FileSystemContext;
    manager: PluginManager;
    retireRuntime(name: string, retirement: PluginMcpRegistrationRetirement): void;
    setStatus(name: string, status: string): void;
    store: InMemorySessionStore;
    started: string[];
    stopped: string[];
    workspace: string;
}> {
    // A plugin's socket lives in its data folder. macOS refuses a Unix socket outside the working
    // directory and caps the whole path near 104 bytes, so the harness stays short and under it.
    const root = await mkdtemp(join(process.cwd(), ".plg-"));
    cleanup.push(() => rm(root, { force: true, recursive: true }));
    const workspace = join(root, "workspace");
    const dataRoot = join(root, "data");
    await mkdir(workspace, { recursive: true });

    const store = new InMemorySessionStore({
        modelCatalog: { defaultModelId: "", defaultProviderId: "", models: [], providers: [] },
    });
    cleanup.push(() => store.close());

    const computeEvents: ComputePreparationEvent[] = [];
    const events: PluginsChangedEvent[] = [];
    store.liveEvents.subscribe((entry: LiveGlobalEventEntry) => {
        if (entry.event.type === "compute_preparation") computeEvents.push(entry.event);
        if (entry.event.type === "plugins_changed") events.push(entry.event);
    });

    // The real starter spawns a sandboxed process, which cannot nest inside the sandbox this
    // suite already runs in. The lifecycle contract is what matters here; spawning is covered by
    // the gym.
    const started: string[] = [];
    const stopped: string[] = [];
    const statusCallbacks = new Map<string, (status: string) => void>();
    const completionCallbacks = new Map<string, () => void>();
    const retirementCallbacks = new Map<
        string,
        (retirement: PluginMcpRegistrationRetirement) => void
    >();
    const startAttempts = new Map<string, number>();
    const manager = new PluginManager({
        daemonLog: new DaemonLog({ path: join(root, "daemon.log"), write: () => {} }),
        ...(options.computeRegistry === undefined
            ? {}
            : { computeRegistry: options.computeRegistry }),
        directory: join(root, "plugins"),
        ...(options.docker === undefined ? {} : { docker: options.docker }),
        ...(options.dockerCleanupTimeoutMs === undefined
            ? {}
            : { dockerCleanupTimeoutMs: options.dockerCleanupTimeoutMs }),
        environment: { HAPPY_PLUGIN_DATA_DIRECTORY: dataRoot } as NodeJS.ProcessEnv,
        mcpRegistry: new PluginMcpRegistry(),
        ...(options.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: options.startupTimeoutMs }),
        start: async (plugin, startOptions) => {
            started.push(plugin.manifest.name);
            const attempt = (startAttempts.get(plugin.folderName) ?? 0) + 1;
            startAttempts.set(plugin.folderName, attempt);
            await options.beforeStart?.(plugin, attempt);
            if (startOptions.onStatus !== undefined) {
                statusCallbacks.set(plugin.manifest.name, startOptions.onStatus);
            }
            const startError =
                typeof options.startError === "function"
                    ? options.startError(plugin, attempt)
                    : options.startError;
            if (startError !== undefined) throw startError;
            let finish = () => {};
            const completion = new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null;
            }>((resolve) => {
                finish = () => resolve({ code: 0, signal: null });
            });
            completionCallbacks.set(plugin.manifest.name, finish);
            const retirement = new Promise<PluginMcpRegistrationRetirement>((resolve) => {
                retirementCallbacks.set(plugin.manifest.name, resolve);
            });
            const logPath = join(plugin.directory, "plugin.log");
            await writeFile(logPath, "[stdout] ready\n");
            const startup = new PluginStartupState();
            if (options.startup === undefined) startup.ready();
            else options.startup(plugin, startup);
            let closed = false;
            return {
                completion,
                dataDirectory: join(dataRoot, plugin.folderName),
                logPath,
                name: plugin.manifest.name,
                pid: 1234,
                retirement,
                startup,
                statusMessage: startup.status === "running" ? "Ready." : undefined,
                close: () => {
                    if (closed) return Promise.resolve();
                    closed = true;
                    stopped.push(plugin.manifest.name);
                    finish();
                    return Promise.resolve();
                },
            };
        },
        store,
    });
    cleanup.push(() => manager.close());

    return {
        computeEvents,
        dataRoot,
        events,
        exitRuntime(name) {
            const callback = completionCallbacks.get(name);
            if (callback === undefined) {
                throw new Error(`No completion callback exists for ${name}.`);
            }
            callback();
        },
        started,
        stopped,
        // Plugin changes run with the Full access boundary the Auto reviewer grants them.
        fs: createNodeFileSystemContext(workspace, { permissionMode: () => "full_access" }),
        manager,
        retireRuntime(name, retirement) {
            const callback = retirementCallbacks.get(name);
            if (callback === undefined) {
                throw new Error(`No retirement callback exists for ${name}.`);
            }
            callback(retirement);
        },
        setStatus(name, status) {
            const callback = statusCallbacks.get(name);
            if (callback === undefined) throw new Error(`No status callback exists for ${name}.`);
            callback(status);
        },
        store,
        workspace,
    };
}

async function createPluginSource(
    directory: string,
    version?: string,
    name = "Clock",
    docker?: true | { image: string },
    computeName?: string,
): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                {
                    description: "A small clock.",
                    ...(computeName === undefined ? {} : { compute: { name: computeName } }),
                    ...(docker === undefined ? {} : { docker }),
                    icon: "icon.png",
                    main: "index.ts",
                    name,
                    ...(version === undefined ? {} : { version }),
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
        writeFile(
            join(directory, "index.ts"),
            ["export {};", 'console.log("ready");', "await new Promise<void>(() => {});", ""].join(
                "\n",
            ),
        ),
    ]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: resolvePromise,
    };
}
