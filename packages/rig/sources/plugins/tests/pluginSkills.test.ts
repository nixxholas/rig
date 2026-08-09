import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { FileSystemContext } from "../../agent/context/FileSystemContext.js";
import { formatSkillsForPrompt } from "../../agent/skills/formatSkillsForPrompt.js";
import { DaemonLog } from "../../server/DaemonLog.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { PluginManager } from "../PluginManager.js";
import { PluginMcpRegistry } from "../PluginMcpRegistry.js";
import { PluginStartupState } from "../PluginStartupState.js";
import { readPluginManifest } from "../readPluginManifest.js";
import type { RegisteredPlugin } from "../types.js";

const PNG_SIGNATURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("plugin skills", () => {
    it("loads a prompt-only plugin's bounded static contribution", async () => {
        const harness = await createHarness();
        const directory = join(harness.pluginsDirectory, "prompt");
        await mkdir(directory, { recursive: true });
        await Promise.all([
            writeFile(
                join(directory, "happy.plugin.json"),
                `${JSON.stringify({
                    author: "Happy",
                    category: "productivity",
                    description: "Release prompt.",
                    icon: "icon.png",
                    name: "Release prompt",
                    systemPrompt: { path: "SYSTEM_PROMPT.md" },
                })}\n`,
            ),
            writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
            writeFile(join(directory, "SYSTEM_PROMPT.md"), "Always name the release owner."),
        ]);

        await harness.manager.start();

        await expect(harness.manager.loadSystemPrompt()).resolves.toBe(
            "Always name the release owner.",
        );
        expect(harness.started).toEqual([]);
    });

    it("merges a running plugin's declared skills with plugin provenance", async () => {
        const harness = await createHarness();
        await createPlugin(join(harness.pluginsDirectory, "release"), {
            entry: true,
            skillDirectory: "contributions",
        });

        await harness.manager.start();
        const skill = (await harness.manager.loadSkills(harness.fs)).find(
            (candidate) => candidate.name === "release-check",
        );

        expect(skill).toMatchObject({
            description: "Check whether a release is ready.",
            source: { folder: "release", plugin: "Release", type: "plugin" },
        });
        expect(formatSkillsForPrompt([skill!])).toContain("<source>plugin: Release</source>");
    });

    it("registers a conventional skills-only plugin without starting a process", async () => {
        const harness = await createHarness();
        const sourceDirectory = join(harness.workspace, "release");
        await createPlugin(sourceDirectory);

        await harness.manager.start();
        await harness.manager.install({ fs: harness.fs, sourceDirectory });

        await expect(harness.manager.list()).resolves.toMatchObject({
            failures: [],
            plugins: [{ name: "Release", status: "running" }],
        });
        expect(harness.started).toEqual([]);
        expect(
            (await harness.manager.loadSkills(harness.fs)).some(
                (skill) => skill.name === "release-check",
            ),
        ).toBe(true);
    });

    it("skips malformed plugin skills with a warning while keeping the plugin running", async () => {
        const harness = await createHarness();
        const directory = join(harness.pluginsDirectory, "release");
        await createPlugin(directory);
        await mkdir(join(directory, "skills", "broken"), { recursive: true });
        await writeFile(
            join(directory, "skills", "broken", "SKILL.md"),
            "---\nname: [invalid\n---\n",
        );

        await harness.manager.start();
        const skills = await harness.manager.loadSkills(harness.fs);

        expect(skills.some((skill) => skill.name === "release-check")).toBe(true);
        expect(skills.some((skill) => skill.name === "broken")).toBe(false);
        await expect(harness.manager.list()).resolves.toMatchObject({
            plugins: [{ status: "running" }],
        });
        expect(harness.logs).toContainEqual(
            expect.objectContaining({
                event: "plugin_skill_skipped",
                level: "warning",
                plugin: "Release",
                pluginFolder: "release",
            }),
        );
    });

    it("keeps a same-named file skill and warns about the skipped plugin skill", async () => {
        const harness = await createHarness();
        await createPlugin(join(harness.pluginsDirectory, "release"));
        const fileSkillDirectory = join(harness.workspace, ".agents", "skills", "release-check");
        await mkdir(fileSkillDirectory, { recursive: true });
        await writeFile(
            join(fileSkillDirectory, "SKILL.md"),
            "---\nname: release-check\ndescription: User release checks.\n---\n",
        );

        await harness.manager.start();
        const skill = (await harness.manager.loadSkills(harness.fs)).find(
            (candidate) => candidate.name === "release-check",
        );

        expect(skill).toMatchObject({
            description: "User release checks.",
            source: { type: "file" },
        });
        expect(harness.logs).toContainEqual(
            expect.objectContaining({
                event: "plugin_skill_name_collision",
                level: "warning",
                plugin: "Release",
                pluginFolder: "release",
                skill: "release-check",
            }),
        );
    });

    it("reuses cached plugin discovery while loading skills", async () => {
        const harness = await createHarness();
        const directory = join(harness.pluginsDirectory, "release");
        await createPlugin(directory);
        await harness.manager.start();
        await unlink(join(directory, "happy.plugin.json"));

        expect(
            (await harness.manager.loadSkills(harness.fs)).some(
                (skill) => skill.name === "release-check",
            ),
        ).toBe(true);
    });

    it("logs unreadable plugin discovery through the daemon log and keeps file skills", async () => {
        const harness = await createHarness();
        const fileSkillDirectory = join(harness.workspace, ".agents", "skills", "review");
        await mkdir(fileSkillDirectory, { recursive: true });
        await writeFile(
            join(fileSkillDirectory, "SKILL.md"),
            "---\nname: review\ndescription: Review changes.\n---\n",
        );
        await rm(harness.pluginsDirectory, { force: true, recursive: true });
        await writeFile(harness.pluginsDirectory, "not a directory\n");

        await expect(harness.manager.loadSkills(harness.fs)).resolves.toContainEqual(
            expect.objectContaining({ name: "review", source: { type: "file" } }),
        );
        expect(harness.logs).toContainEqual(
            expect.objectContaining({
                event: "plugin_skills_unreadable",
                level: "warning",
            }),
        );
    });

    it("reports a missing declared skills directory in human-readable text", async () => {
        const harness = await createHarness();
        const directory = join(harness.pluginsDirectory, "missing");
        await mkdir(directory, { recursive: true });
        await Promise.all([
            writeFile(
                join(directory, "happy.plugin.json"),
                `${JSON.stringify({
                    author: "Happy",
                    category: "developer-tools",
                    description: "Missing skills.",
                    icon: "icon.png",
                    name: "Missing",
                    skills: "not-there",
                })}\n`,
            ),
            writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
        ]);

        await expect(readPluginManifest(directory)).rejects.toThrow(
            "The plugin skills directory does not exist.",
        );
    });

    it("ignores an undeclared conventional skills path that is not a directory", async () => {
        const harness = await createHarness();
        const directory = join(harness.pluginsDirectory, "release");
        await createPlugin(directory, { entry: true });
        await rm(join(directory, "skills"), { force: true, recursive: true });
        await writeFile(join(directory, "skills"), "not a skill directory\n");

        await expect(readPluginManifest(directory)).resolves.toMatchObject({
            entryPath: join(directory, "index.ts"),
        });
        await expect(readPluginManifest(directory)).resolves.not.toHaveProperty("skillsPath");
    });

    it("removes a plugin's skills from the merged catalog when it is uninstalled", async () => {
        const harness = await createHarness();
        await createPlugin(join(harness.pluginsDirectory, "release"));
        await harness.manager.start();
        expect(
            (await harness.manager.loadSkills(harness.fs)).some(
                (skill) => skill.name === "release-check",
            ),
        ).toBe(true);

        await harness.manager.uninstall({ fs: harness.fs, name: "Release" });

        expect(
            (await harness.manager.loadSkills(harness.fs)).some(
                (skill) => skill.name === "release-check",
            ),
        ).toBe(false);
    });
});

async function createHarness(): Promise<{
    fs: FileSystemContext;
    logs: Record<string, unknown>[];
    manager: PluginManager;
    pluginsDirectory: string;
    started: string[];
    workspace: string;
}> {
    const root = await mkdtemp(join(process.cwd(), ".plugin-skills-"));
    cleanup.push(() => rm(root, { force: true, recursive: true }));
    const pluginsDirectory = join(root, "plugins");
    const workspace = join(root, "workspace");
    await Promise.all([
        mkdir(pluginsDirectory, { recursive: true }),
        mkdir(workspace, { recursive: true }),
    ]);
    const store = await InMemorySessionStore.open({
        modelCatalog: { defaultModelId: "", defaultProviderId: "", models: [], providers: [] },
    });
    cleanup.push(() => store.close());
    const logs: Record<string, unknown>[] = [];
    const started: string[] = [];
    const manager = new PluginManager({
        daemonLog: new DaemonLog({
            path: join(root, "daemon.log"),
            write: (_path, line) => logs.push(JSON.parse(line) as Record<string, unknown>),
        }),
        directory: pluginsDirectory,
        mcpRegistry: new PluginMcpRegistry(),
        start: async (plugin: RegisteredPlugin) => {
            started.push(plugin.manifest.name);
            const startup = new PluginStartupState();
            startup.ready();
            let finish = () => {};
            const completion = new Promise<{
                code: number | null;
                signal: NodeJS.Signals | null;
            }>((resolve) => {
                finish = () => resolve({ code: 0, signal: null });
            });
            return {
                completion,
                dataDirectory: join(root, "data", plugin.folderName),
                logPath: join(plugin.directory, ".build", "plugin.log"),
                name: plugin.manifest.name,
                pid: 1234,
                retirement: new Promise(() => {}),
                startup,
                statusMessage: "Ready.",
                close: async () => finish(),
            };
        },
        store,
    });
    cleanup.push(() => manager.close());
    return {
        fs: createNodeFileSystemContext(workspace, { permissionMode: () => "full_access" }),
        logs,
        manager,
        pluginsDirectory,
        started,
        workspace,
    };
}

async function createPlugin(
    directory: string,
    options: { entry?: boolean; skillDirectory?: string } = {},
): Promise<void> {
    const skillDirectory = options.skillDirectory ?? "skills";
    await mkdir(join(directory, skillDirectory, "release-check"), { recursive: true });
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                {
                    author: "Happy",
                    category: "developer-tools",
                    description: "Release workflow skills.",
                    icon: "icon.png",
                    ...(options.entry === true ? { main: "index.ts" } : {}),
                    name: "Release",
                    ...(options.skillDirectory === undefined
                        ? {}
                        : { skills: `${options.skillDirectory}/` }),
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
        writeFile(
            join(directory, skillDirectory, "release-check", "SKILL.md"),
            [
                "---",
                "name: release-check",
                "description: Check whether a release is ready.",
                "---",
                "",
                "# Release check",
                "",
            ].join("\n"),
        ),
        ...(options.entry === true ? [writeFile(join(directory, "index.ts"), "export {};\n")] : []),
    ]);
}
