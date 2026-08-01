import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { PermissionMode } from "../../permissions/index.js";
import { pluginInstallTool, pluginListTool, pluginUninstallTool } from "./pluginTools.js";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("plugin tools", () => {
    it("reviews every plugin action and elevates only the two that change the installation", () => {
        const context = {} as AgentContext;

        expect(pluginInstallTool.shouldReviewInAutoMode({ path: "./clock" }, context)).toBe(true);
        expect(
            pluginInstallTool.shouldRunInFullAccessInAutoMode({ path: "./clock" }, context),
        ).toBe(true);
        expect(pluginUninstallTool.shouldReviewInAutoMode({ name: "Clock" }, context)).toBe(true);
        expect(
            pluginUninstallTool.shouldRunInFullAccessInAutoMode({ name: "Clock" }, context),
        ).toBe(true);
        expect(pluginListTool.shouldReviewInAutoMode({}, context)).toBe(true);
        expect(pluginListTool.shouldRunInFullAccessInAutoMode({}, context)).toBe(false);
    });

    it("discloses the folder it reaches outside the workspace", async () => {
        const { context, rigHome } = await createHarness();

        const install = await pluginInstallTool.describeAutoPermissionAction?.(
            { path: "clock" },
            context,
        );
        expect(install).toContain(join(context.fs.cwd, "clock"));
        expect(install).toContain(join(rigHome, "plugins"));
        expect(install).toContain("outside the workspace sandbox");

        expect(
            await pluginUninstallTool.describeAutoPermissionAction?.({ name: "Clock" }, context),
        ).toContain("keeping the folder it writes to");
    });

    it("installs a plugin from a path, then lists and uninstalls it by name", async () => {
        const { context, dataRoot, rigHome, workspace } = await createHarness();
        await createPluginSource(join(workspace, "clock"));

        const installed = await pluginInstallTool.execute({ path: "clock" }, context, {});
        expect(installed).toMatchObject({ folder: "clock", name: "Clock" });
        expect(installed.directory).toBe(join(rigHome, "plugins", "clock"));
        // The build ran against the installed copy rather than the source folder.
        await expect(
            readFile(join(installed.directory, ".build", "build", "index.js"), "utf8"),
        ).resolves.toContain("ready");

        const listed = await pluginListTool.execute({}, context, {});
        expect(listed.failures).toEqual([]);
        expect(listed.plugins).toEqual([
            {
                dataDirectory: join(dataRoot, "clock"),
                description: "A small clock.",
                folder: "clock",
                name: "Clock",
            },
        ]);

        // A plugin keeps whatever it wrote while it was installed.
        await mkdir(join(dataRoot, "clock"), { recursive: true });
        await writeFile(join(dataRoot, "clock", "state.json"), '{"ticks":3}\n');

        const removed = await pluginUninstallTool.execute({ name: "Clock" }, context, {});
        expect(removed).toEqual({
            dataDirectory: join(dataRoot, "clock"),
            folder: "clock",
            name: "Clock",
        });
        await expect(context.fs.exists(installed.directory)).resolves.toBe(false);
        await expect(readFile(join(dataRoot, "clock", "state.json"), "utf8")).resolves.toBe(
            '{"ticks":3}\n',
        );
        await expect(pluginListTool.execute({}, context, {})).resolves.toMatchObject({
            plugins: [],
        });
    });

    it("installs nothing when the sources do not compile", async () => {
        const { context, rigHome, workspace } = await createHarness();
        await createPluginSource(join(workspace, "broken"), {
            source: 'const ticks: number = "not a number";\n',
        });

        await expect(pluginInstallTool.execute({ path: "broken" }, context, {})).rejects.toThrow(
            /could not build/iu,
        );
        await expect(context.fs.exists(join(rigHome, "plugins", "broken"))).resolves.toBe(false);
        await expect(context.fs.readdir(join(rigHome, "plugins"))).resolves.toEqual([]);
    });

    it("keeps a working installation when a reinstall fails to build", async () => {
        const { context, rigHome, workspace } = await createHarness();
        const source = join(workspace, "clock");
        await createPluginSource(source);
        await pluginInstallTool.execute({ path: "clock" }, context, {});

        await writeFile(join(source, "index.ts"), 'const ticks: number = "not a number";\n');
        await expect(pluginInstallTool.execute({ path: "clock" }, context, {})).rejects.toThrow(
            /could not build/iu,
        );

        await expect(
            readFile(join(rigHome, "plugins", "clock", "index.ts"), "utf8"),
        ).resolves.toContain("ready");
    });

    it("cannot reach the plugins folder without the elevation Auto grants", async () => {
        const { context, workspace } = await createHarness({ permissionMode: "workspace_write" });
        await createPluginSource(join(workspace, "clock"));

        await expect(pluginInstallTool.execute({ path: "clock" }, context, {})).rejects.toThrow(
            /outside the working directory/iu,
        );
    });

    it("refuses a folder that is not a plugin and a name that is not installed", async () => {
        const { context, workspace } = await createHarness();
        await mkdir(join(workspace, "not-a-plugin"), { recursive: true });

        await expect(
            pluginInstallTool.execute({ path: "not-a-plugin" }, context, {}),
        ).rejects.toThrow("happy.plugin.json");
        await expect(pluginInstallTool.execute({ path: "missing" }, context, {})).rejects.toThrow(
            "not a folder",
        );
        await expect(pluginUninstallTool.execute({ name: "Clock" }, context, {})).rejects.toThrow(
            "No plugins are installed.",
        );
    });

    it("refuses sources that reach outside the plugin folder through a link", async () => {
        const { context, workspace } = await createHarness();
        const source = join(workspace, "linked");
        await createPluginSource(source);
        await writeFile(join(workspace, "outside.ts"), 'console.log("outside");\n');
        await symlink(join(workspace, "outside.ts"), join(source, "extra.ts"));

        await expect(pluginInstallTool.execute({ path: "linked" }, context, {})).rejects.toThrow(
            "symbolic links",
        );
    });
});

async function createHarness(options: { permissionMode?: PermissionMode } = {}): Promise<{
    context: AgentContext;
    dataRoot: string;
    rigHome: string;
    workspace: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-plugin-tools-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const rigHome = join(root, "rig-home");
    const dataRoot = join(root, "plugin-data");
    await mkdir(workspace, { recursive: true });
    vi.stubEnv("RIG_HOME", rigHome);
    vi.stubEnv("HAPPY_PLUGIN_DATA_DIRECTORY", dataRoot);

    // Plugin tools run with the Full access boundary the Auto reviewer grants them.
    const permissionMode = options.permissionMode ?? "full_access";
    const context = {
        fs: createNodeFileSystemContext(workspace, { permissionMode: () => permissionMode }),
    } as AgentContext;
    return { context, dataRoot, rigHome, workspace };
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
