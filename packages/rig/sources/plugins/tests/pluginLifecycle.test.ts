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
        expect(installed).toMatchObject({ folder: "clock", name: "Clock" });

        // The plugin is registered and running by the time install resolves.
        const afterInstall = await harness.manager.list();
        expect(afterInstall.plugins).toEqual([
            {
                dataDirectory: join(harness.dataRoot, "clock"),
                description: "A small clock.",
                directory: installed.directory,
                folder: "clock",
                name: "Clock",
                running: true,
            },
        ]);
        expect(lastPlugins(harness.events)).toEqual(afterInstall.plugins);
        expect(harness.started).toEqual(["Clock"]);
        expect(harness.stopped).toEqual([]);

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

    it("keeps a running plugin when a replacement fails to build", async () => {
        const harness = await createHarness();
        await harness.manager.start();
        const source = join(harness.workspace, "clock");
        await createPluginSource(source);
        await harness.manager.install({ fs: harness.fs, sourceDirectory: source });

        await writeFile(join(source, "index.ts"), 'const ticks: number = "not a number";\n');
        await expect(
            harness.manager.install({ fs: harness.fs, sourceDirectory: source }),
        ).rejects.toThrow(/could not build/iu);

        const listed = await harness.manager.list();
        expect(listed.plugins).toMatchObject([{ name: "Clock", running: true }]);
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
});

function lastPlugins(events: readonly PluginsChangedEvent[]): unknown {
    return events.at(-1)?.data.plugins;
}

async function createHarness(): Promise<{
    dataRoot: string;
    events: PluginsChangedEvent[];
    fs: FileSystemContext;
    manager: PluginManager;
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
        start: (plugin) => {
            started.push(plugin.manifest.name);
            let finish = () => {};
            const completion = new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null;
            }>((resolve) => {
                finish = () => resolve({ code: 0, signal: null });
            });
            return Promise.resolve({
                completion,
                dataDirectory: join(dataRoot, plugin.folderName),
                logPath: join(plugin.directory, ".build", "plugin.log"),
                name: plugin.manifest.name,
                pid: 1234,
                close: () => {
                    stopped.push(plugin.manifest.name);
                    finish();
                    return Promise.resolve();
                },
            });
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
        workspace,
    };
}

async function createPluginSource(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                {
                    description: "A small clock.",
                    entry: "index.ts",
                    icon: "icon.png",
                    name: "Clock",
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
