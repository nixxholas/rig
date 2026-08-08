import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Dockerode from "dockerode";
import { afterAll, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import { DaemonLog } from "../../server/DaemonLog.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createPluginDockerContainerName } from "../createPluginDockerContainerOptions.js";
import { PluginManager } from "../PluginManager.js";
import { PluginMcpRegistry } from "../PluginMcpRegistry.js";
import { readPluginManifest } from "../readPluginManifest.js";
import { resolvePluginDockerImage } from "../resolvePluginDockerRuntime.js";

const PNG_SIGNATURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);
const docker = new Dockerode();
const dockerAvailable = await docker.ping().then(
    () => true,
    () => false,
);
const cleanup: (() => Promise<void> | void)[] = [];

afterAll(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe.skipIf(!dockerAvailable)("Docker plugin lifecycle", () => {
    it("builds, starts, reaches ready over the mounted socket, and removes the container on uninstall", async () => {
        // macOS limits Unix socket paths to roughly 104 bytes. Keep this fixture short and
        // beneath the bind-mounted workspace, matching production's shared working folder.
        const root = await mkdtemp(join(process.cwd(), ".pd-"));
        cleanup.push(() => rm(root, { force: true, recursive: true }));
        const workspace = join(root, "w");
        const pluginsDirectory = join(root, "p");
        const dataRoot = join(root, "d");
        const source = join(workspace, "s");
        await mkdir(source, { recursive: true });
        await Promise.all([
            writeFile(
                join(source, "happy.plugin.json"),
                `${JSON.stringify(
                    {
                        author: "Happy",
                        category: "developer-tools",
                        description: "A Docker lifecycle fixture.",
                        icon: "icon.png",
                        main: "index.ts",
                        name: "Docker Clock",
                    },
                    null,
                    2,
                )}\n`,
            ),
            writeFile(join(source, "icon.png"), PNG_SIGNATURE),
            writeFile(join(source, "Dockerfile"), "FROM node:24-alpine\nWORKDIR /plugin\n"),
            writeFile(
                join(source, "index.ts"),
                [
                    'import { happy } from "happy-plugins";',
                    'console.log("docker-plugin-ready");',
                    'await happy.ready("Ready in Docker.");',
                    "const keepAlive = setInterval(() => {}, 60_000);",
                    "await new Promise<void>((resolve) => {",
                    '    process.once("SIGTERM", resolve);',
                    '    process.once("SIGINT", resolve);',
                    "});",
                    "clearInterval(keepAlive);",
                    "",
                ].join("\n"),
            ),
        ]);
        const sourcePlugin = await readPluginManifest(source);
        const image = await resolvePluginDockerImage(sourcePlugin);
        await docker
            .getImage(image)
            .remove({ force: true })
            .catch(() => undefined);
        cleanup.push(() =>
            docker
                .getImage(image)
                .remove({ force: true })
                .then(() => undefined)
                .catch(() => undefined),
        );

        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const manager = new PluginManager({
            daemonLog: new DaemonLog({
                path: join(root, "daemon.log"),
                write: () => {},
            }),
            directory: pluginsDirectory,
            environment: {
                HAPPY_PLUGIN_DATA_DIRECTORY: dataRoot,
                HOME: process.env.HOME,
                PATH: process.env.PATH,
                SHELL: process.env.SHELL,
            },
            mcpRegistry: new PluginMcpRegistry(),
            startupTimeoutMs: 60_000,
            store,
        });
        cleanup.push(() => manager.close());
        await manager.start();

        const installed = await manager.install({
            fs: createNodeFileSystemContext(workspace, {
                permissionMode: () => "full_access",
            }),
            sourceDirectory: source,
        });

        const catalog = await manager.list();
        const processLog = await readFile(join(installed.directory, "plugin.log"), "utf8");
        const startupLog = await manager.readLog("Docker Clock");
        expect(catalog.plugins[0]?.error, processLog).toBeUndefined();
        expect(processLog).toContain(`Building Docker image ${image}.`);
        expect(catalog).toMatchObject({
            plugins: [
                {
                    name: "Docker Clock",
                    status: "running",
                    statusMessage: "Ready in Docker.",
                },
            ],
        });
        expect(startupLog).toMatchObject({
            status: "running",
            text: expect.stringContaining("docker-plugin-ready"),
        });
        const plugin = await readPluginManifest(installed.directory);
        expect(plugin.docker).toBeDefined();
        const containerName = createPluginDockerContainerName({
            directory: plugin.directory,
            folderName: plugin.folderName,
            image: await resolvePluginDockerImage(plugin),
        });
        await expect(docker.getContainer(containerName).inspect()).resolves.toMatchObject({
            State: { Running: true },
        });

        await manager.uninstall({
            fs: createNodeFileSystemContext(workspace, {
                permissionMode: () => "full_access",
            }),
            name: "Docker Clock",
        });

        await expect(docker.getContainer(containerName).inspect()).rejects.toMatchObject({
            statusCode: 404,
        });
        await expect(docker.getImage(image).inspect()).rejects.toMatchObject({
            statusCode: 404,
        });
    }, 180_000);
});
