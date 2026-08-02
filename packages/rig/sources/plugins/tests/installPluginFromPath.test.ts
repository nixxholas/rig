import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { FileSystemContext } from "../../agent/context/FileSystemContext.js";
import { installPluginFromPath } from "../installPluginFromPath.js";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("installing a plugin from a folder", () => {
    it("compiles the installed copy and leaves generated state behind", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        await createPluginSource(join(workspace, "clock"));

        const installed = await installPluginFromPath({
            fs,
            pluginsDirectory,
            sourceDirectory: join(workspace, "clock"),
        });

        expect(installed).toMatchObject({
            description: "A small clock.",
            directory: join(pluginsDirectory, "clock"),
            folder: "clock",
            name: "Clock",
        });
        await expect(
            readFile(join(installed.directory, ".build", "build", "index.js"), "utf8"),
        ).resolves.toContain("ready");
    });

    it("installs nothing when the sources do not compile", async () => {
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
        ).rejects.toThrow(/could not build/iu);
        // Neither the plugin nor its staging folder survives a failed install.
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

    it("keeps the previous installation when a replacement fails to build", async () => {
        const { fs, pluginsDirectory, workspace } = await createHarness();
        const source = join(workspace, "clock");
        await createPluginSource(source);
        await installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source });

        await writeFile(join(source, "index.ts"), 'const ticks: number = "not a number";\n');
        await expect(
            installPluginFromPath({ fs, pluginsDirectory, sourceDirectory: source }),
        ).rejects.toThrow(/could not build/iu);

        await expect(
            readFile(join(pluginsDirectory, "clock", "index.ts"), "utf8"),
        ).resolves.toContain("ready");
    });

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
    options: { source?: string } = {},
): Promise<void> {
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
        writeFile(join(directory, "index.ts"), options.source ?? 'console.log("ready");\n'),
    ]);
}
