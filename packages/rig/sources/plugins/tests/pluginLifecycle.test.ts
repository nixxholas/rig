import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { FileSystemContext } from "../../agent/context/FileSystemContext.js";
import type { LiveGlobalEventEntry } from "../../global-event/LiveGlobalEventQueue.js";
import type { PluginsChangedEvent } from "../../protocol/index.js";
import { DaemonLog } from "../../server/DaemonLog.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { PluginManager } from "../PluginManager.js";
import { PluginMcpRegistry } from "../PluginMcpRegistry.js";
import { MAXIMUM_PLUGIN_LOG_READ_BYTES } from "../readBoundedPluginLog.js";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("plugin registration", () => {
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
});

function lastPlugins(events: readonly PluginsChangedEvent[]): unknown {
    return events.at(-1)?.data.plugins;
}

async function createHarness(options: { startError?: Error } = {}): Promise<{
    dataRoot: string;
    events: PluginsChangedEvent[];
    fs: FileSystemContext;
    manager: PluginManager;
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

    const events: PluginsChangedEvent[] = [];
    store.liveEvents.subscribe((entry: LiveGlobalEventEntry) => {
        if (entry.event.type === "plugins_changed") events.push(entry.event);
    });

    // The real starter spawns a sandboxed process, which cannot nest inside the sandbox this
    // suite already runs in. The lifecycle contract is what matters here; spawning is covered by
    // the gym.
    const started: string[] = [];
    const stopped: string[] = [];
    const manager = new PluginManager({
        daemonLog: new DaemonLog({ path: join(root, "daemon.log"), write: () => {} }),
        directory: join(root, "plugins"),
        environment: { HAPPY_PLUGIN_DATA_DIRECTORY: dataRoot } as NodeJS.ProcessEnv,
        mcpRegistry: new PluginMcpRegistry(),
        start: async (plugin) => {
            started.push(plugin.manifest.name);
            if (options.startError !== undefined) throw options.startError;
            let finish = () => {};
            const completion = new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null;
            }>((resolve) => {
                finish = () => resolve({ code: 0, signal: null });
            });
            const logPath = join(plugin.directory, "plugin.log");
            await writeFile(logPath, "[stdout] ready\n");
            return {
                completion,
                dataDirectory: join(dataRoot, plugin.folderName),
                logPath,
                name: plugin.manifest.name,
                pid: 1234,
                close: () => {
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
        dataRoot,
        events,
        started,
        stopped,
        // Plugin changes run with the Full access boundary the Auto reviewer grants them.
        fs: createNodeFileSystemContext(workspace, { permissionMode: () => "full_access" }),
        manager,
        store,
        workspace,
    };
}

async function createPluginSource(directory: string, version?: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                {
                    description: "A small clock.",
                    icon: "icon.png",
                    main: "index.ts",
                    name: "Clock",
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
