import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

afterEach(async () => {
    await Promise.all(
        cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("happy-plugin development runner", () => {
    it("starts TypeScript, seeds projects, lists tools, and calls one without Docker", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-plugin-runner-"));
        cleanup.push(directory);
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "happy-plugin-runner-tmp-"));
        cleanup.push(temporaryDirectory);
        const entryPath = join(directory, "index.ts");
        const seedPath = join(directory, "seed.json");
        const nodeModules = join(directory, "node_modules");
        await mkdir(nodeModules);
        await symlink(
            packageRoot,
            join(nodeModules, "happy-plugins"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await writeFile(
            entryPath,
            [
                'import { readFile, writeFile } from "node:fs/promises";',
                'import { defineMcpTool, happy, Type } from "happy-plugins";',
                "const statePath = `${process.env.HAPPY_PLUGIN_DIRECTORY}/state.txt`;",
                'await writeFile(statePath, "persisted by plugin");',
                'const persisted = await readFile(statePath, "utf8");',
                "await happy.mcp.startServer({",
                '  name: "Project tools",',
                "  tools: [defineMcpTool({",
                '    name: "list_projects",',
                '    description: "List projects.",',
                "    inputSchema: Type.Object({}),",
                "    async execute() {",
                '      return { content: [{ type: "text", text: JSON.stringify({ persisted, projects: await happy.projects.list() }) }] };',
                "    },",
                "  })],",
                "});",
                'await happy.ready("Ready.");',
                "",
            ].join("\n"),
        );
        await writeFile(
            seedPath,
            JSON.stringify({
                projects: [{ id: "project-1", name: "Rig", path: "/workspace/rig" }],
            }),
        );

        await execFileAsync("pnpm", ["run", "build"], {
            cwd: packageRoot,
            env: {
                ...process.env,
                TMPDIR: temporaryDirectory,
            },
        });
        const { stdout } = await execFileAsync(
            process.execPath,
            [
                join(packageRoot, "dist", "developmentRunner.js"),
                "dev",
                entryPath,
                "--seed",
                seedPath,
                "--list-tools",
                "--call",
                "Project tools/list_projects",
            ],
            {
                env: { ...process.env, TMPDIR: temporaryDirectory },
                maxBuffer: 1024 * 1024,
                timeout: 15_000,
            },
        );

        expect(stdout).toContain("[fake Happy] POST /mcp/servers");
        expect(stdout).toContain('"tool": "list_projects"');
        expect(stdout).toContain('\\"name\\":\\"Rig\\"');
        expect(stdout).toContain('\\"persisted\\":\\"persisted by plugin\\"');
        expect(await readdir(directory)).toEqual(["index.ts", "node_modules", "seed.json"]);

        await mkdir(join(directory, "app"));
        await writeFile(join(directory, "app", "index.html"), "<h1>App</h1>");
        await writeFile(
            join(directory, "happy.plugin.json"),
            JSON.stringify({
                apps: [
                    {
                        id: "app",
                        page: "missing.html",
                        root: "app",
                        sidebar: { label: "App", order: 0 },
                        title: "App",
                    },
                ],
                author: "Happy",
                category: "developer-tools",
                description: "Development fixture",
                icon: "icon.png",
                main: "index.ts",
                name: "Development fixture",
            }),
        );
        await expect(
            execFileAsync(
                process.execPath,
                [join(packageRoot, "dist", "developmentRunner.js"), "dev", entryPath],
                { env: { ...process.env, TMPDIR: temporaryDirectory }, timeout: 15_000 },
            ),
        ).rejects.toMatchObject({ stderr: expect.stringContaining("page must name an HTML") });
        await writeFile(
            join(directory, "happy.plugin.json"),
            JSON.stringify({
                apps: [
                    {
                        id: "app",
                        page: "index.html",
                        root: "app",
                        sidebar: { icon: "index.html", label: "App", order: 0 },
                        title: "App",
                    },
                ],
                author: "Happy",
                category: "developer-tools",
                description: "Development fixture",
                icon: "icon.png",
                main: "index.ts",
                name: "Development fixture",
            }),
        );
        await expect(
            execFileAsync(
                process.execPath,
                [join(packageRoot, "dist", "developmentRunner.js"), "dev", entryPath],
                { env: { ...process.env, TMPDIR: temporaryDirectory }, timeout: 15_000 },
            ),
        ).rejects.toMatchObject({ stderr: expect.stringContaining("icon must be an image") });

        const packageJson = JSON.parse(
            await readFile(join(packageRoot, "package.json"), "utf8"),
        ) as { engines?: { node?: string } };
        expect(packageJson.engines?.node).toBe(">=22.6.0");
    });
});
