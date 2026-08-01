import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPlugin } from "../buildPlugin.js";
import { discoverPlugins } from "../discoverPlugins.js";
import { PluginBuildError } from "../PluginBuildError.js";
import { PluginLog } from "../PluginLog.js";
import { getPluginDataDirectory } from "../getPluginDataDirectory.js";
import { getPluginsDirectory } from "../getPluginsDirectory.js";
import { readPluginManifest } from "../readPluginManifest.js";

const require = createRequire(import.meta.url);
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("plugins", () => {
    it("installs plugins inside Rig's managed home", () => {
        expect(getPluginsDirectory({}, "/Users/steve")).toBe("/Users/steve/.happy/rig/plugins");
        expect(getPluginsDirectory({ RIG_HOME: "/tmp/isolated-home/rig" }, "/home/steve")).toBe(
            "/tmp/isolated-home/rig/plugins",
        );
        expect(
            getPluginsDirectory({ HAPPY_PLUGINS_DIRECTORY: "/srv/plugins" }, "/home/steve"),
        ).toBe("/srv/plugins");
        expect(() =>
            getPluginsDirectory({ HAPPY_PLUGINS_DIRECTORY: "relative" }, "/home/steve"),
        ).toThrow("must be an absolute path");
    });

    it("gives each plugin a writable folder a person can open", () => {
        expect(getPluginDataDirectory("clock", {}, "/Users/steve", "darwin")).toBe(
            "/Users/steve/Happy/Plugins/clock",
        );
        expect(getPluginDataDirectory("clock", {}, "/home/steve", "linux")).toBe(
            "/home/steve/happy/plugins/clock",
        );
        expect(
            getPluginDataDirectory(
                "clock",
                { HAPPY_PLUGIN_DATA_DIRECTORY: "/srv/plugin-data" },
                "/home/steve",
                "linux",
            ),
        ).toBe("/srv/plugin-data/clock");
        expect(() =>
            getPluginDataDirectory(
                "clock",
                { HAPPY_PLUGIN_DATA_DIRECTORY: "relative" },
                "/home/steve",
                "linux",
            ),
        ).toThrow("must be an absolute path");
    });

    it("registers only folders with a TypeBox-valid manifest and PNG icon", async () => {
        const root = await temporaryDirectory();
        await createPluginFixture(join(root, "clock"), {
            source: 'console.log("tick");\n',
        });
        await createPluginFixture(join(root, "broken"), {
            manifest: {
                description: "Has an unexpected field",
                entry: "index.ts",
                icon: "icon.png",
                name: "Broken",
                permission: "all",
            },
        });

        const discovery = await discoverPlugins(root);
        expect(discovery.plugins.map((plugin) => plugin.manifest.name)).toEqual(["Clock"]);
        expect(discovery.failures).toHaveLength(1);
        expect(discovery.failures[0]?.error).toContain("happy.plugin.json is invalid");
    });

    it("rejects manifest assets that escape through symbolic links", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "linked");
        const externalEntry = join(root, "outside.ts");
        await createPluginFixture(directory, {});
        await writeFile(externalEntry, 'console.log("outside");\n');
        await rm(join(directory, "index.ts"));
        await symlink(externalEntry, join(directory, "index.ts"));

        await expect(readPluginManifest(directory)).rejects.toThrow(
            "The plugin entry must be a file.",
        );
    });

    it("keeps captured plugin output within its configured bound", async () => {
        const root = await temporaryDirectory();
        const logPath = join(root, "plugin.log");
        const log = new PluginLog({ maximumBytes: 64, path: logPath });
        log.append("stdout", Buffer.alloc(1024, "x"));
        await log.close();

        await expect(readFile(logPath)).resolves.toHaveLength(64);
    });

    it("builds with TypeScript 7 against Rig's SDK and rejects incompatible calls", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "builder");
        await createPluginFixture(directory, {
            source: [
                'import { happy } from "happy-plugins";',
                "const projects = await happy.projects.list();",
                'console.log(projects.map((project) => project.name).join(","));',
                "",
            ].join("\n"),
        });
        const plugin = await readPluginManifest(directory);
        const sdkModuleDirectory = dirname(require.resolve("happy-plugins"));
        const built = await buildPlugin(plugin, { sdkModuleDirectory });
        await expect(readFile(built.builtEntryPath, "utf8")).resolves.toContain(
            'from "happy-plugins"',
        );
        expect(built.runtimeDirectory).toBe(join(directory, ".build"));

        await writeFile(
            plugin.entryPath,
            [
                'import { happy } from "happy-plugins";',
                'await happy.workspaces.create({ name: 42, projectId: "project" });',
                "",
            ].join("\n"),
        );
        await expect(buildPlugin(plugin, { sdkModuleDirectory })).rejects.toBeInstanceOf(
            PluginBuildError,
        );
    });
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "rig-plugins-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function createPluginFixture(
    directory: string,
    options: {
        manifest?: Record<string, unknown>;
        source?: string;
    },
): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                options.manifest ?? {
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
        writeFile(join(directory, "index.ts"), options.source ?? 'console.log("ready");\n'),
    ]);
}
