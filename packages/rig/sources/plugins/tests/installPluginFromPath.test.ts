import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { FileSystemContext } from "../../agent/context/FileSystemContext.js";
import { installPluginFromPath } from "../installPluginFromPath.js";

const PNG_SIGNATURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("installing a plugin from a folder", () => {
    it("copies and validates a prebuilt plugin without generating build output", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        await createPluginSource(join(workspace, "clock"));

        const installed = await installPluginFromPath({
            fs,
            pluginsDirectory,
            sourceDirectory: join(workspace, "clock"),
        });

        expect(installed).toMatchObject({
            classification: "fresh-install",
            description: "A small clock.",
            directory: join(pluginsDirectory, "clock"),
            folder: "clock",
            name: "Clock",
            version: "0.0.0",
        });
        await expect(readFile(join(installed.directory, "index.ts"), "utf8")).resolves.toContain(
            "ready",
        );
        await expect(fs.exists(join(installed.directory, ".build"))).resolves.toBe(false);
    });

    it("installs TypeScript as-is without running a compiler", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        await createPluginSource(join(workspace, "broken"), {
            source: 'const ticks: number = "not a number";\n',
        });

        await expect(
            installPluginFromPath({
                fs,
                pluginsDirectory,
                sourceDirectory: join(workspace, "broken"),
            }),
        ).resolves.toMatchObject({ name: "Clock" });
        await expect(readFile(join(pluginsDirectory, "broken", "index.ts"), "utf8")).resolves.toBe(
            'const ticks: number = "not a number";\n',
        );
    });

    it("rejects a missing main entry point without installing a partial plugin", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        const source = join(workspace, "missing");
        await createPluginSource(source);
        await rm(join(source, "index.ts"));

        await expect(
            installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source }),
        ).rejects.toThrow('The plugin main entry point "index.ts" does not exist.');
        await expect(fs.readdir(pluginsDirectory)).resolves.toEqual([]);
    });

    it("stops before staging when installation is already cancelled", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        const source = join(workspace, "clock");
        await createPluginSource(source);
        const controller = new AbortController();
        controller.abort();

        await expect(
            installPluginFromPath({
                fs,
                pluginsDirectory,
                signal: controller.signal,
                sourceDirectory: source,
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        await expect(fs.exists(pluginsDirectory)).resolves.toBe(false);
    });

    it("keeps the previous installation when a replacement has no main entry point", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        const source = join(workspace, "clock");
        await createPluginSource(source);
        await installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source });

        await rm(join(source, "index.ts"));
        await expect(
            installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source }),
        ).rejects.toThrow('The plugin main entry point "index.ts" does not exist.');

        await expect(
            readFile(join(pluginsDirectory, "clock", "index.ts"), "utf8"),
        ).resolves.toContain("ready");
    });

    it("repairs a corrupted existing installation and classifies it as a reinstall", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        const source = join(workspace, "clock");
        await createPluginSource(source, { version: "1.0.0" });
        await installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source });
        await writeFile(join(pluginsDirectory, "clock", "happy.plugin.json"), "{");
        await createPluginSource(source, { version: "2.0.0" });

        await expect(
            installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source }),
        ).resolves.toMatchObject({
            classification: "reinstall",
            version: "2.0.0",
        });
        await expect(
            readFile(join(pluginsDirectory, "clock", "happy.plugin.json"), "utf8"),
        ).resolves.toContain('"version": "2.0.0"');
    });

    it.each([
        { classification: "upgrade", nextVersion: "2.0.0", previousVersion: "1.0.0" },
        { classification: "downgrade", nextVersion: "1.0.0", previousVersion: "2.0.0" },
        { classification: "reinstall", nextVersion: "1.0.0", previousVersion: "1.0.0" },
    ] as const)(
        "classifies an install over an existing folder as a $classification",
        async ({ classification, nextVersion, previousVersion }) => {
            const { fs, pluginsDirectory, workspace } = await createHarness();
            const source = join(workspace, "clock");
            await createPluginSource(source, { version: previousVersion });
            await installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source });
            await createPluginSource(source, { version: nextVersion });

            await expect(
                installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source }),
            ).resolves.toMatchObject({
                classification,
                version: nextVersion,
            });
        },
    );

    it("refuses a folder that is not a plugin", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        await mkdir(join(workspace, "not-a-plugin"), { recursive: true });

        await expect(
            installPluginFromPath({
                fs,
                pluginsDirectory,
                sourceDirectory: join(workspace, "not-a-plugin"),
            }),
        ).rejects.toThrow("happy.plugin.json");
        await expect(
            installPluginFromPath({
                fs,
                pluginsDirectory,
                sourceDirectory: join(workspace, "missing"),
            }),
        ).rejects.toThrow("not a folder");
    });

    it("refuses sources that reach outside the plugin folder through a link", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        const source = join(workspace, "linked");
        await createPluginSource(source);
        await writeFile(join(workspace, "outside.ts"), 'console.log("outside");\n');
        await symlink(join(workspace, "outside.ts"), join(source, "extra.ts"));

        await expect(
            installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source }),
        ).rejects.toThrow("symbolic links");
    });

    it("cannot reach the plugins folder without the elevation Auto grants", async () => {
        const { pluginsDirectory, workspace } = await createHarness();
        await createPluginSource(join(workspace, "clock"));
        const sandboxed = createNodeFileSystemContext(workspace, {
            permissionMode: () => "workspace_write",
        });

        await expect(
            installPluginFromPath({
                fs: sandboxed,
                pluginsDirectory,
                sourceDirectory: join(workspace, "clock"),
            }),
        ).rejects.toThrow(/outside the working directory/iu);
    });
});

async function createHarness(): Promise<{
    fs: FileSystemContext;
    pluginsDirectory: string;
    workspace: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-plugin-install-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    return {
        // Installing runs with the Full access boundary the Auto reviewer grants it.
        fs: createNodeFileSystemContext(workspace, { permissionMode: () => "full_access" }),
        pluginsDirectory: join(root, "plugins"),
        workspace,
    };
}

async function createPluginSource(
    directory: string,
    options: { source?: string; version?: string } = {},
): Promise<void> {
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                {
                    author: "Happy",
                    category: "utilities",
                    description: "A small clock.",
                    icon: "icon.png",
                    main: "index.ts",
                    name: "Clock",
                    ...(options.version === undefined ? {} : { version: options.version }),
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
        writeFile(join(directory, "index.ts"), options.source ?? 'console.log("ready");\n'),
    ]);
}
