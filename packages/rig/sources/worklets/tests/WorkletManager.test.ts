import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import type { WorkletPermissions, WorkletsChangedEvent } from "../../protocol/WorkletProtocol.js";
import { getWorkletRuntimeDirectory } from "../getWorkletRuntimeDirectory.js";
import { WorkletManager } from "../WorkletManager.js";
import { WorkletStore } from "../WorkletStore.js";
import { WorkletToolRegistry, workletToolName } from "../WorkletToolRegistry.js";

const SEALED: WorkletPermissions = { disk: "none", network: "none" };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("WorkletManager", () => {
    it("runs an installed worklet, exposes its tool to an agent, and answers a call", async () => {
        const source = await workletSource(
            { description: "Adds numbers", name: "adder" },
            `
            import { defineWorkletTool, Type, worklet } from "happy-worklets";

            await worklet.tools([
                defineWorkletTool({
                    description: "Adds two numbers.",
                    inputSchema: Type.Object({ left: Type.Number(), right: Type.Number() }),
                    name: "add",
                    execute: ({ left, right }) => ({
                        content: [{ text: String(left + right), type: "text" }],
                    }),
                }),
            ]);
            await worklet.ready("Adding numbers.");
        `,
        );
        const harness = await createHarness();

        const installed = await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });

        expect(installed.failure).toBeUndefined();
        expect(installed).toMatchObject({ currentVersion: 1, name: "adder", state: "running" });
        expect(installed.status).toBe("Adding numbers.");
        expect(installed.tools).toEqual([{ description: "Adds two numbers.", name: "add" }]);

        const loaded = await harness.registry.load(source.path, "auto");
        const tool = loaded.tools.find((entry) => entry.name === workletToolName("adder", "add"));
        expect(tool).toBeDefined();

        const result = await tool!.execute({ left: 2, right: 3 } as never, {} as never, {});

        expect(result).toMatchObject({ content: [{ text: "5", type: "text" }] });
    });

    it("keeps its socket in Rig's private folder, leaving the data folder to the worklet", async () => {
        const source = await workletSource(
            {
                description: "Looks at its own folder",
                name: "looker",
            },
            `
            import { readdir } from "node:fs/promises";

            import { defineWorkletTool, Type, worklet } from "happy-worklets";

            await worklet.tools([
                defineWorkletTool({
                    description: "Lists the worklet's own data folder.",
                    inputSchema: Type.Object({}),
                    name: "own_files",
                    execute: async () => ({
                        content: [{ text: (await readdir(worklet.data)).join(","), type: "text" }],
                    }),
                }),
            ]);
            await worklet.ready();
        `,
        );
        const harness = await createHarness();

        const installed = await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });

        expect(installed.state).toBe("running");
        // Rig reached the worklet, so a socket exists — and it is not in the worklet's data folder.
        await expect(readdir(installed.dataDirectory)).resolves.toEqual([]);
        const runtimeDirectory = getWorkletRuntimeDirectory("looker", harness.environment);
        await expect(readdir(runtimeDirectory)).resolves.toEqual(["tmp", "worklet.sock"]);
        expect(runtimeDirectory.startsWith(installed.dataDirectory)).toBe(false);

        // The worklet sees the same empty folder from inside its own sandbox.
        const loaded = await harness.registry.load(source.path, "auto");
        const tool = loaded.tools.find(
            (entry) => entry.name === workletToolName("looker", "own_files"),
        );
        await expect(tool!.execute({} as never, {} as never, {})).resolves.toMatchObject({
            content: [{ text: "", type: "text" }],
        });

        await harness.manager.uninstall("looker");
        // Rig's own runtime folder goes with the worklet; the worklet's data folder does not.
        await expect(readdir(runtimeDirectory)).rejects.toThrow();
        await expect(readdir(installed.dataDirectory)).resolves.toEqual([]);
    });

    it("runs transform-requiring TypeScript through jiti", async () => {
        const source = await workletSource(
            {
                description: "Uses TypeScript that needs code generation",
                name: "typescript",
            },
            `
            import { worklet } from "happy-worklets";

            enum Phase {
                Ready = "ready",
            }

            class State {
                constructor(readonly phase: Phase) {}
            }

            await worklet.ready(new State(Phase.Ready).phase);
        `,
        );
        const harness = await createHarness();

        const installed = await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });

        expect(installed).toMatchObject({ state: "running", status: "ready" });
    });

    it("uses disposable private temp space without exposing the shared host temp", async () => {
        const hostTemporaryDirectory = await temporaryDirectory("rig-worklet-host-temp-");
        const hostTarget = join(hostTemporaryDirectory, "escaped.txt");
        const source = await workletSource(
            {
                description: "Uses its private temporary folder",
                name: "temporary",
            },
            `
            import { writeFile } from "node:fs/promises";
            import { dirname, join } from "node:path";

            import { worklet } from "happy-worklets";

            const temporaryDirectory = process.env.TMPDIR;
            if (temporaryDirectory === undefined) throw new Error("TMPDIR is missing");
            await writeFile(join(temporaryDirectory, "private.txt"), "private");
            await writeFile(${JSON.stringify(hostTarget)}, "escaped").catch(() => undefined);
            await writeFile(
                join(dirname(process.env.HAPPY_WORKLET_SOCKET_PATH), "escaped.txt"),
                "escaped",
            ).catch(() => undefined);
            await worklet.ready(temporaryDirectory);
        `,
        );
        const harness = await createHarness();

        const installed = await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });
        const runtimeDirectory = getWorkletRuntimeDirectory("temporary", harness.environment);

        expect(installed).toMatchObject({
            state: "running",
            status: join(runtimeDirectory, "tmp"),
        });
        await expect(readFile(join(runtimeDirectory, "tmp", "private.txt"), "utf8")).resolves.toBe(
            "private",
        );
        await expect(readFile(hostTarget, "utf8")).rejects.toThrow();
        await expect(readFile(join(runtimeDirectory, "escaped.txt"), "utf8")).rejects.toThrow();

        await harness.manager.uninstall("temporary");
        await expect(readdir(runtimeDirectory)).rejects.toThrow();
    });

    it("refuses a worklet's write outside its data folder when its manifest asked for nothing", async () => {
        const outside = await scratchDirectory();
        const target = join(outside, "escaped.txt");
        const source = await workletSource(
            {
                description: "Tries to write elsewhere",
                name: "escaper",
                permissions: SEALED,
            },
            `
            import { writeFile } from "node:fs/promises";

            import { defineWorkletTool, Type, worklet } from "happy-worklets";

            await worklet.tools([
                defineWorkletTool({
                    description: "Tries to write outside the data folder.",
                    inputSchema: Type.Object({}),
                    name: "escape",
                    execute: async () => {
                        try {
                            await writeFile(${JSON.stringify(target)}, "escaped");
                            return { content: [{ text: "wrote", type: "text" }] };
                        } catch (error) {
                            return { content: [{ text: "refused", type: "text" }] };
                        }
                    },
                }),
            ]);
            await worklet.ready();
        `,
        );
        const harness = await createHarness();

        await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });
        const loaded = await harness.registry.load(source.path, "auto");
        const tool = loaded.tools.find(
            (entry) => entry.name === workletToolName("escaper", "escape"),
        );

        await expect(tool!.execute({} as never, {} as never, {})).resolves.toMatchObject({
            content: [{ text: "refused", type: "text" }],
        });
        await expect(readFile(target, "utf8")).rejects.toThrow();
    });

    it("keeps a worklet's data folder across an update and stops the old process", async () => {
        const source = await workletSource(
            {
                description: "Counts its own versions",
                name: "counter",
            },
            `
            import { readFile, writeFile } from "node:fs/promises";
            import { join } from "node:path";

            import { defineWorkletTool, Type, worklet } from "happy-worklets";

            const file = join(worklet.data, "runs.txt");
            const before = await readFile(file, "utf8").catch(() => "");
            await writeFile(file, before + "1");

            await worklet.tools([
                defineWorkletTool({
                    description: "Reports how many versions have run.",
                    inputSchema: Type.Object({}),
                    name: "runs",
                    execute: async () => ({
                        content: [{ text: await readFile(file, "utf8"), type: "text" }],
                    }),
                }),
            ]);
            await worklet.ready();
        `,
        );
        const harness = await createHarness();

        const installed = await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });
        expect(installed.state).toBe("running");
        await expect(readFile(join(installed.dataDirectory, "runs.txt"), "utf8")).resolves.toBe(
            "1",
        );

        const updated = await harness.manager.update("counter", {
            changeDescription: "Second import",
            path: source.path,
        });

        expect(updated).toMatchObject({ currentVersion: 2, state: "running" });
        // The same data folder is handed to the new version, so its own writes accumulate.
        await expect(readFile(join(updated.dataDirectory, "runs.txt"), "utf8")).resolves.toBe("11");
        // Exactly one generation is registered, so the replaced process is gone.
        const loaded = await harness.registry.load(source.path, "auto");
        expect(loaded.tools).toHaveLength(1);
    });

    it("stops a worklet that is still starting rather than leaving its process behind", async () => {
        const source = await workletSource(
            {
                description: "Takes its time",
                name: "slow",
            },
            `
            import { worklet } from "happy-worklets";

            await new Promise((resolve) => setTimeout(resolve, 1_000));
            await worklet.ready();
        `,
        );
        const harness = await createHarness();

        // Uninstalling while the launch is still in flight must not orphan the child process.
        const installing = harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });
        const installed = await installing;
        const uninstalling = harness.manager.uninstall("slow");
        await uninstalling;

        expect(installed.name).toBe("slow");
        expect(await harness.manager.get("slow")).toBeUndefined();
        await expect(
            readdir(getWorkletRuntimeDirectory("slow", harness.environment)),
        ).rejects.toThrow();
    });

    it("keeps uninstall behind an update whose stored version has not launched yet", async () => {
        const source = await workletSource(
            { description: "Serializes lifecycle changes", name: "serialized" },
            `
            import { worklet } from "happy-worklets";
            await worklet.ready();
        `,
        );
        const harness = await createHarness();
        await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });

        const originalUpdate = harness.store.update.bind(harness.store);
        const originalRemove = harness.store.remove.bind(harness.store);
        let releaseUpdate: () => void = () => undefined;
        const updateGate = new Promise<void>((resolve) => {
            releaseUpdate = resolve;
        });
        let reportCommitted: () => void = () => undefined;
        const committed = new Promise<void>((resolve) => {
            reportCommitted = resolve;
        });
        let removeCalled = false;
        harness.store.update = async (name, request, sourceFileSystem, expected) => {
            const stored = await originalUpdate(name, request, sourceFileSystem, expected);
            reportCommitted();
            await updateGate;
            return stored;
        };
        harness.store.remove = async (name) => {
            removeCalled = true;
            return originalRemove(name);
        };

        const updating = harness.manager.update("serialized", {
            changeDescription: "Second version",
            path: source.path,
        });
        await committed;
        const uninstalling = harness.manager.uninstall("serialized");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(removeCalled).toBe(false);
        releaseUpdate();
        await updating;
        await uninstalling;
        expect(await harness.manager.get("serialized")).toBeUndefined();
        await expect(harness.registry.load(source.path, "auto")).resolves.toMatchObject({
            tools: [],
        });
    });

    it("does not let an old tool-stream retirement stop its replacement generation", async () => {
        const source = await workletSource(
            { description: "Retires its first generation", name: "retiring" },
            `
            import { defineWorkletTool, Type, worklet } from "happy-worklets";
            await worklet.tools([
                defineWorkletTool({
                    description: "The old generation.",
                    inputSchema: Type.Object({}),
                    name: "old",
                    execute: () => ({ content: [{ text: "old", type: "text" }] }),
                }),
            ]);
            await worklet.ready();
            setTimeout(() => process.exit(0), 100);
        `,
        );
        const harness = await createHarness();
        await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });
        await writeFile(
            join(source.path, "index.ts"),
            `
                import { defineWorkletTool, Type, worklet } from "happy-worklets";
                await worklet.tools([
                    defineWorkletTool({
                        description: "The replacement generation.",
                        inputSchema: Type.Object({}),
                        name: "replacement",
                        execute: () => ({ content: [{ text: "new", type: "text" }] }),
                    }),
                ]);
                await worklet.ready();
            `,
        );

        const originalUpdate = harness.store.update.bind(harness.store);
        let reportEntered: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => {
            reportEntered = resolve;
        });
        let releaseUpdate: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseUpdate = resolve;
        });
        harness.store.update = async (...parameters) => {
            reportEntered();
            await gate;
            return originalUpdate(...parameters);
        };

        const updating = harness.manager.update("retiring", {
            changeDescription: "Stable replacement",
            path: source.path,
        });
        await entered;
        await vi.waitFor(async () =>
            expect((await harness.manager.get("retiring"))?.state).toBe("stopped"),
        );
        releaseUpdate();

        await expect(updating).resolves.toMatchObject({ state: "running" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await harness.manager.get("retiring")).toMatchObject({
            state: "running",
            tools: [{ name: "replacement" }],
        });
    });

    it.runIf(process.platform === "darwin")(
        "prevents a detached descendant from escaping the worklet lifecycle",
        async () => {
            const source = await workletSource(
                {
                    description: "Starts a descendant process",
                    name: "descendants",
                },
                `
                import { spawnSync } from "node:child_process";
                import { writeFile } from "node:fs/promises";
                import { join } from "node:path";

                import { worklet } from "happy-worklets";

                const descendant = spawnSync(
                    process.execPath,
                    ["-e", "setInterval(() => {}, 60_000)"],
                    { detached: true, stdio: "ignore" },
                );
                await writeFile(
                    join(worklet.data, "descendant.txt"),
                    descendant.error === undefined ? "started" : "refused",
                );
                await worklet.ready();
            `,
            );
            const harness = await createHarness();

            const installed = await harness.manager.install({
                authorSessionId: "agent-1",
                iconPath: source.iconPath,
                path: source.path,
            });

            await expect(
                readFile(join(installed.dataDirectory, "descendant.txt"), "utf8"),
            ).resolves.toBe("refused");
        },
    );

    it("reports a worklet that never says it is ready as failed, with its output in the log", async () => {
        const source = await workletSource(
            {
                description: "Fails immediately",
                name: "broken",
            },
            `
            console.error("this worklet is broken");
            process.exit(3);
        `,
        );
        const harness = await createHarness();

        const installed = await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });

        expect(installed.state).toBe("failed");
        expect(installed.failure).toBeDefined();
        const log = await harness.manager.readLog("broken");
        expect(log.log).toContain("this worklet is broken");
        await expect(harness.registry.load(source.path, "auto")).resolves.toMatchObject({
            tools: [],
        });
    });

    it("drains an admitted status publication before closing its database owner", async () => {
        const source = await workletSource(
            {
                description: "Reports ready status",
                name: "status-drain",
            },
            `
            import { defineWorkletTool, Type, worklet } from "happy-worklets";

            await worklet.tools([
                defineWorkletTool({
                    description: "Reports a new status.",
                    inputSchema: Type.Object({}),
                    name: "report",
                    execute: async () => {
                        await worklet.status("Draining.");
                        return { content: [{ text: "reported", type: "text" }] };
                    },
                }),
            ]);
            await worklet.ready();
        `,
        );
        const harness = await createHarness();
        await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });
        const originalList = harness.store.list.bind(harness.store);
        let reportPublicationStarted: () => void = () => undefined;
        const publicationStarted = new Promise<void>((resolve) => {
            reportPublicationStarted = resolve;
        });
        let releasePublication: () => void = () => undefined;
        const publicationGate = new Promise<void>((resolve) => {
            releasePublication = resolve;
        });
        let listCalls = 0;
        harness.store.list = async () => {
            listCalls += 1;
            if (listCalls === 1) {
                reportPublicationStarted();
                await publicationGate;
            }
            return await originalList();
        };

        const loaded = await harness.registry.load(source.path, "auto");
        const report = loaded.tools.find(
            (entry) => entry.name === workletToolName("status-drain", "report"),
        );
        const reporting = report!.execute({} as never, {} as never, {});
        await publicationStarted;
        await expect(reporting).resolves.toMatchObject({
            content: [{ text: "reported", type: "text" }],
        });

        let closed = false;
        const closing = harness.manager.close().then(() => {
            closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
        releasePublication();
        await closing;
        expect(closed).toBe(true);
    });

    it("announces the whole current set on every change, with a version that moves forward", async () => {
        const source = await workletSource(
            {
                description: "Does nothing",
                name: "idle",
            },
            `
            import { worklet } from "happy-worklets";
            await worklet.ready();
        `,
        );
        const harness = await createHarness();

        await harness.manager.install({
            authorSessionId: "agent-1",
            iconPath: source.iconPath,
            path: source.path,
        });
        await harness.manager.uninstall("idle");

        const names = harness.published.map((event) =>
            event.data.worklets.map((worklet) => worklet.name),
        );
        expect(names).toContainEqual(["idle"]);
        expect(names.at(-1)).toEqual([]);
        const versions = harness.published.map((event) => event.data.version);
        expect([...versions].sort()).toEqual(versions);
        expect(new Set(versions).size).toBe(versions.length);
        expect((await harness.manager.catalog()).version).toBe(versions.at(-1));
    });
});

interface Harness {
    environment: NodeJS.ProcessEnv;
    manager: WorkletManager;
    published: WorkletsChangedEvent[];
    registry: WorkletToolRegistry;
    rigHome: string;
    store: WorkletStore;
    workletsDirectory: string;
}

async function createHarness(): Promise<Harness> {
    const root = await temporaryDirectory("rig-worklet-root-");
    // Sockets live under RIG_HOME now, so the test gets its own rather than writing to the real one.
    const rigHome = await scratchDirectory();
    const opened = await openSessionDatabase(":memory:");
    await migrateSessionDatabase(opened.database);
    const registry = new WorkletToolRegistry();
    const published: WorkletsChangedEvent[] = [];
    const environment = { ...process.env, HAPPY_WORKLETS_DIRECTORY: root, RIG_HOME: rigHome };
    const workletStore = new WorkletStore({
        environment: { HAPPY_WORKLETS_DIRECTORY: root },
        tx: () => opened.database,
    });
    const manager = new WorkletManager({
        environment,
        publish: (event) => published.push(event),
        registry,
        store: workletStore,
    });
    cleanups.push(async () => {
        await manager.close();
        await opened.client.close();
    });
    return {
        environment,
        manager,
        published,
        registry,
        rigHome,
        store: workletStore,
        workletsDirectory: root,
    };
}

interface SourceManifest {
    description: string;
    name: string;
    permissions?: WorkletPermissions;
}

async function workletSource(
    manifest: SourceManifest,
    entry: string,
): Promise<{ iconPath: string; path: string }> {
    const directory = await temporaryDirectory("rig-worklet-source-");
    await writeFile(
        join(directory, "worklet.json"),
        JSON.stringify({ permissions: SEALED, ...manifest }, null, 4),
    );
    await writeFile(join(directory, "index.ts"), `${dedent(entry)}\n`);
    const iconPath = join(directory, "icon.png");
    await writeFile(iconPath, await iconPng());
    // Every worklet folder carries both documents, so every fixture folder does too.
    await writeFile(
        join(directory, "README.md"),
        `# ${manifest.name}\n\n${manifest.description}, in words a person reads.\n`,
    );
    await writeFile(
        join(directory, "DEVELOPMENT.md"),
        `# Development\n\nHow ${manifest.name} works inside, for whoever changes it next.\n`,
    );
    return { iconPath, path: directory };
}

function dedent(text: string): string {
    const lines = text.replace(/^\n/u, "").replace(/\s+$/u, "").split("\n");
    const indent = Math.min(
        ...lines
            .filter((line) => line.trim().length > 0)
            .map((line) => line.length - line.trimStart().length),
    );
    return lines.map((line) => line.slice(indent)).join("\n");
}

async function iconPng(): Promise<Buffer> {
    return sharp({
        create: {
            background: { alpha: 1, b: 50, g: 100, r: 200 },
            channels: 4,
            height: 512,
            width: 512,
        },
    })
        .png()
        .toBuffer();
}

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return directory;
}

/**
 * A folder outside every place the sandbox makes writable on its own.
 *
 * The temporary directory is always writable, in every permission mode, so a test about what a
 * worklet may reach has to put its target somewhere else. The repository's own scratch folder is
 * also short enough for the Rig home a worklet's socket hangs off: a Unix socket address is a
 * small fixed-size kernel field, and the per-user temporary folder on macOS is longer.
 */
async function scratchDirectory(): Promise<string> {
    const scratch = resolve(process.cwd(), "../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "r"));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return directory;
}
