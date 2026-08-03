import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { discoverPlugins } from "../discoverPlugins.js";
import { PluginLog } from "../PluginLog.js";
import { getPluginDataDirectory } from "../getPluginDataDirectory.js";
import { getPluginsDirectory } from "../getPluginsDirectory.js";
import { MAXIMUM_PLUGIN_LOG_READ_BYTES, readBoundedPluginLog } from "../readBoundedPluginLog.js";
import { readPluginManifest } from "../readPluginManifest.js";
import { PluginIconSummaryCache } from "../readPluginIcon.js";

const PNG_SIGNATURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);
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
                author: "Happy",
                category: "utilities",
                description: "Has an unexpected field",
                icon: "icon.png",
                main: "index.ts",
                name: "Broken",
                permission: "all",
            },
        });

        const discovery = await discoverPlugins(root);
        expect(discovery.plugins.map((plugin) => plugin.manifest.name)).toEqual(["Clock"]);
        expect(discovery.failures).toHaveLength(1);
        expect(discovery.failures[0]?.error).toContain("happy.plugin.json is invalid");
    });

    it("validates and normalizes manifest versions", async () => {
        const root = await temporaryDirectory();
        const versioned = join(root, "versioned");
        const unversioned = join(root, "unversioned");
        const invalid = join(root, "invalid");
        await Promise.all([
            createPluginFixture(versioned, {
                manifest: pluginManifest({ version: "1.2.3-beta.1+build.7" }),
            }),
            createPluginFixture(unversioned, {}),
            createPluginFixture(invalid, {
                manifest: pluginManifest({ version: "1.2" }),
            }),
        ]);

        await expect(readPluginManifest(versioned)).resolves.toMatchObject({
            manifest: { version: "1.2.3-beta.1+build.7" },
        });
        await expect(readPluginManifest(unversioned)).resolves.toMatchObject({
            manifest: { version: "0.0.0" },
        });
        await expect(readPluginManifest(invalid)).rejects.toThrow(
            "Expected a semantic version such as 1.2.3.",
        );
    });

    it("accepts only bounded square PNG catalog icons", async () => {
        const root = await temporaryDirectory();
        const valid = join(root, "valid");
        const rectangular = join(root, "rectangular");
        const tooWide = join(root, "too-wide");
        const oversized = join(root, "oversized");
        const jpeg = join(root, "jpeg");
        const truncated = join(root, "truncated");
        await Promise.all([
            createPluginFixture(valid, {}),
            createPluginFixture(rectangular, {}),
            createPluginFixture(tooWide, {}),
            createPluginFixture(oversized, {}),
            createPluginFixture(jpeg, {}),
            createPluginFixture(truncated, {}),
        ]);
        await writeFile(
            join(rectangular, "icon.png"),
            await sharp({
                create: {
                    background: "#336699",
                    channels: 4,
                    height: 32,
                    width: 64,
                },
            })
                .png()
                .toBuffer(),
        );
        await writeFile(
            join(tooWide, "icon.png"),
            await sharp({
                create: {
                    background: "#336699",
                    channels: 3,
                    height: 4_096,
                    width: 4_096,
                },
            })
                .png({ compressionLevel: 9 })
                .toBuffer(),
        );
        await writeFile(join(oversized, "icon.png"), Buffer.alloc(4 * 1024 * 1024 + 1));
        await writeFile(
            join(jpeg, "icon.png"),
            await sharp({
                create: { background: "#336699", channels: 3, height: 32, width: 32 },
            })
                .jpeg()
                .toBuffer(),
        );
        await writeFile(join(truncated, "icon.png"), PNG_SIGNATURE.subarray(0, 40));

        await expect(readPluginManifest(valid)).resolves.toMatchObject({
            icon: {
                generation: expect.stringMatching(/^[a-f0-9]{64}$/u),
                mediaType: "image/png",
                size: expect.any(Number),
            },
        });
        await expect(readPluginManifest(rectangular)).rejects.toThrow(
            "The plugin icon must be square.",
        );
        await expect(readPluginManifest(tooWide)).rejects.toThrow(
            "The plugin icon dimensions must be between 1 and 2048 pixels.",
        );
        await expect(readPluginManifest(oversized)).rejects.toThrow(
            "The plugin icon cannot exceed 4 MiB.",
        );
        await expect(readPluginManifest(jpeg)).rejects.toThrow(
            "The plugin icon is not a valid PNG image.",
        );
        await expect(readPluginManifest(truncated)).rejects.toThrow(
            "The plugin icon is not a valid PNG image.",
        );
    });

    it("memoizes icon summaries until the file identity changes", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "cached");
        await createPluginFixture(directory, {});
        const cache = new PluginIconSummaryCache();
        const first = await cache.read(join(directory, "icon.png"));
        const unchanged = await cache.read(join(directory, "icon.png"));
        expect(unchanged).toBe(first);

        const replacement = await sharp({
            create: { background: "#123456", channels: 4, height: 2, width: 2 },
        })
            .png()
            .toBuffer();
        await writeFile(join(directory, "icon.png"), replacement);
        const changed = await cache.read(join(directory, "icon.png"));
        expect(changed).not.toBe(first);
        expect(changed.generation).not.toBe(first.generation);
    });

    it("rejects manifest assets that escape through symbolic links", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "linked");
        const externalEntry = join(root, "outside.ts");
        const externalIcon = join(root, "outside.png");
        await createPluginFixture(directory, {});
        await writeFile(externalEntry, 'console.log("outside");\n');
        await rm(join(directory, "index.ts"));
        await symlink(externalEntry, join(directory, "index.ts"));

        await expect(readPluginManifest(directory)).rejects.toThrow(
            "The plugin main entry point must be a file.",
        );

        await rm(join(directory, "index.ts"));
        await writeFile(join(directory, "index.ts"), 'console.log("inside");\n');
        await writeFile(externalIcon, PNG_SIGNATURE);
        await rm(join(directory, "icon.png"));
        await symlink(externalIcon, join(directory, "icon.png"));
        await expect(readPluginManifest(directory)).rejects.toThrow(
            "The plugin icon must be an ordinary file.",
        );

        const externalAssets = join(root, "outside-assets");
        await mkdir(externalAssets);
        await Promise.all([
            writeFile(join(externalAssets, "index.ts"), 'console.log("outside");\n'),
            writeFile(join(externalAssets, "icon.png"), PNG_SIGNATURE),
        ]);
        await rm(join(directory, "index.ts"));
        await rm(join(directory, "icon.png"));
        await symlink(externalAssets, join(directory, "assets"));
        const manifest = pluginManifest({ icon: "assets/icon.png", main: "assets/index.ts" });
        await writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
        );
        await expect(readPluginManifest(directory)).rejects.toThrow("must stay inside its folder");
    });

    it("keeps recent output within its bound and resets between current runs", async () => {
        const root = await temporaryDirectory();
        const logPath = join(root, "plugin.log");
        const log = new PluginLog({ maximumBytes: 64, path: logPath });
        log.append("stdout", Buffer.alloc(1024, "x"));
        log.append("stdout", Buffer.from("LATEST_OUTPUT\n"));
        await log.close();

        await expect(readFile(logPath)).resolves.toHaveLength(64);
        const retained = await readFile(logPath, "utf8");
        expect(retained).toContain("Earlier plugin output omitted");
        expect(retained).toContain("LATEST_OUTPUT");

        const nextRun = new PluginLog({ maximumBytes: 64, path: logPath });
        nextRun.append("stdout", Buffer.from("fresh run\n"));
        await nextRun.close();
        await expect(readFile(logPath, "utf8")).resolves.toBe("[stdout] fresh run\n");
    });

    it("preserves multibyte chunk boundaries and reads only the newest 16 KiB", async () => {
        const root = await temporaryDirectory();
        const logPath = join(root, "plugin.log");
        const log = new PluginLog({ maximumBytes: 80, path: logPath });
        log.append("stdout", Buffer.alloc(200, "o"));
        const emoji = Buffer.from("🙂");
        log.append("stdout", emoji.subarray(0, 2));
        log.append("stdout", emoji.subarray(2));
        log.append("stdout", Buffer.from(" NEWEST_MULTIBYTE\n"));
        await log.close();

        const retained = await readFile(logPath, "utf8");
        expect(retained).toContain("🙂 NEWEST_MULTIBYTE");
        expect(retained).not.toContain("�");

        await writeFile(logPath, `${"old-output\n".repeat(2_000)}🙂 NEWEST_PROTOCOL_OUTPUT\n`);
        const snapshot = await readBoundedPluginLog(logPath);
        expect(snapshot.truncated).toBe(true);
        expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(MAXIMUM_PLUGIN_LOG_READ_BYTES);
        expect(snapshot.text).toContain("🙂 NEWEST_PROTOCOL_OUTPUT");
        expect(snapshot.text).not.toContain("�");
    });

    it("registers JavaScript and TypeScript main entry points without building them", async () => {
        const root = await temporaryDirectory();
        const typescript = join(root, "typescript");
        const javascript = join(root, "javascript");
        await Promise.all([
            createPluginFixture(typescript, {}),
            createPluginFixture(javascript, {
                manifest: pluginManifest({ main: "index.mjs" }),
                sourceFile: "index.mjs",
            }),
        ]);

        await expect(readPluginManifest(typescript)).resolves.toMatchObject({
            entryPath: join(typescript, "index.ts"),
        });
        await expect(readPluginManifest(javascript)).resolves.toMatchObject({
            entryPath: join(javascript, "index.mjs"),
        });
    });

    it("reports a missing main entry point as a clear registration failure", async () => {
        const root = await temporaryDirectory();
        await createPluginFixture(join(root, "missing"), {});
        await rm(join(root, "missing", "index.ts"));

        await expect(discoverPlugins(root)).resolves.toMatchObject({
            failures: [
                {
                    error: 'The plugin main entry point "index.ts" does not exist.',
                    folderName: "missing",
                },
            ],
            plugins: [],
        });
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
        sourceFile?: string;
    },
): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                options.manifest ?? {
                    author: "Happy",
                    category: "utilities",
                    description: "A small clock.",
                    icon: "icon.png",
                    main: "index.ts",
                    name: "Clock",
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
        writeFile(
            join(directory, options.sourceFile ?? "index.ts"),
            options.source ?? 'console.log("ready");\n',
        ),
    ]);
}

function pluginManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        author: "Happy",
        category: "utilities",
        description: "A small clock.",
        icon: "icon.png",
        main: "index.ts",
        name: "Clock",
        ...overrides,
    };
}
