import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import type Dockerode from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createPluginDockerContainerName,
    createPluginDockerContainerOptions,
    PLUGIN_CONTAINER_BOOTSTRAP_PATH,
    PLUGIN_CONTAINER_CODE_DIRECTORY,
    PLUGIN_CONTAINER_DATA_DIRECTORY,
    PLUGIN_CONTAINER_LOADER_PATH,
    PLUGIN_CONTAINER_SDK_DIRECTORY,
    PLUGIN_CONTAINER_TOKEN_PATH,
    PLUGIN_CONTAINER_TYPEBOX_DIRECTORY,
} from "../createPluginDockerContainerOptions.js";
import { createPluginDockerClient } from "../createPluginDockerClient.js";
import { armPluginDockerBridgeHandshakeTimeout } from "../armPluginDockerBridgeHandshakeTimeout.js";
import {
    createPluginDockerFolderIdentity,
    PLUGIN_DOCKER_FOLDER_LABEL,
    PLUGIN_DOCKER_MANAGED_LABEL,
} from "../pluginDockerOwnership.js";
import { preparePluginDockerImage, removePluginDockerImages } from "../preparePluginDockerImage.js";
import { readPluginManifest } from "../readPluginManifest.js";
import { resolvePluginDockerImage } from "../resolvePluginDockerRuntime.js";
import {
    removePluginDockerContainers,
    startPluginDockerContainer,
} from "../startPluginDockerContainer.js";
import { readPluginDockerBridgeAuthentication } from "../startPluginDockerSocketBridge.js";
import { withPluginDockerDeadline } from "../withPluginDockerDeadline.js";

const PNG_SIGNATURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("Docker plugin manifests", () => {
    it("uses a root Dockerfile as the runtime signal and derives a stable content image", async () => {
        const directory = await createPlugin({ dockerfile: "FROM node:24-alpine\n" });

        const first = await readPluginManifest(directory);
        const second = await readPluginManifest(directory);

        expect(first.docker).toEqual({
            dockerfilePath: join(directory, "Dockerfile"),
            type: "dockerfile",
        });
        expect(second.docker).toEqual(first.docker);
        await expect(resolvePluginDockerImage(first)).resolves.toMatch(
            /^rig-plugin-clock:[a-f0-9]{24}$/u,
        );
        await expect(resolvePluginDockerImage(second)).resolves.toBe(
            await resolvePluginDockerImage(first),
        );
    });

    it("accepts an explicit prebuilt image without a Dockerfile", async () => {
        const directory = await createPlugin({
            docker: { image: "registry.example.com/happy/clock:1.2.3" },
        });

        await expect(readPluginManifest(directory)).resolves.toMatchObject({
            docker: {
                image: "registry.example.com/happy/clock:1.2.3",
                type: "image",
            },
        });
    });

    it("requires a Dockerfile for the boolean declaration", async () => {
        const directory = await createPlugin({ docker: true });

        await expect(readPluginManifest(directory)).rejects.toThrow(
            'declares "docker": true but its folder has no Dockerfile',
        );
    });
});

describe("Docker plugin client", () => {
    it("uses the configured Docker socket", () => {
        expect(
            createPluginDockerClient({
                socketPath: "/custom/docker.sock",
                workingDirectory: "/workspace",
            }),
        ).toHaveProperty("modem.socketPath", "/custom/docker.sock");
    });
});

describe("Docker plugin container construction", () => {
    it("constructs a read-only, capability-free container with translated runtime paths", () => {
        const options = createPluginDockerContainerOptions({
            bootstrapPath: "/host/rig/plugin-docker-bootstrap.js",
            codeDirectory: "/host/plugins/clock",
            containerName: "rig-plugin-clock-generation",
            dataDirectory: "/host/data/clock",
            entryPath: "dist/index.mjs",
            environment: {
                ANTHROPIC_API_KEY: "must-not-leak",
                HOME: "/Users/steve",
                LANG: "en_US.UTF-8",
                PATH: "/host/bin",
                SHARED_VALUE: "passed-through",
            },
            folderName: "clock",
            image: "clock:local",
            imageEnvironment: ["PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=24"],
            loaderPath: "/host/rig/plugin-sdk-loader.js",
            sdkModuleDirectory: "/host/rig/plugin-sdk",
            tokenFilePath: "/host/data/clock/.runtime/token",
            typeboxModuleDirectory: "/host/rig/typebox",
        });

        expect(options).toMatchObject({
            name: "rig-plugin-clock-generation",
            Cmd: [
                PLUGIN_CONTAINER_BOOTSTRAP_PATH,
                "0",
                "--import",
                `file://${PLUGIN_CONTAINER_LOADER_PATH}?sdk=${encodeURIComponent(PLUGIN_CONTAINER_SDK_DIRECTORY)}`,
                `${PLUGIN_CONTAINER_CODE_DIRECTORY}/dist/index.mjs`,
            ],
            Entrypoint: ["node"],
            HostConfig: {
                CapDrop: ["ALL"],
                Memory: 2 * 1024 * 1024 * 1024,
                Mounts: [
                    {
                        ReadOnly: true,
                        Source: "/host/plugins/clock",
                        Target: PLUGIN_CONTAINER_CODE_DIRECTORY,
                    },
                    {
                        ReadOnly: false,
                        Source: "/host/data/clock",
                        Target: PLUGIN_CONTAINER_DATA_DIRECTORY,
                    },
                    {
                        ReadOnly: true,
                        Source: "/host/rig/plugin-sdk-loader.js",
                        Target: PLUGIN_CONTAINER_LOADER_PATH,
                    },
                    {
                        ReadOnly: true,
                        Source: "/host/rig/plugin-sdk",
                        Target: PLUGIN_CONTAINER_SDK_DIRECTORY,
                    },
                    {
                        ReadOnly: true,
                        Source: "/host/rig/plugin-docker-bootstrap.js",
                        Target: PLUGIN_CONTAINER_BOOTSTRAP_PATH,
                    },
                    {
                        ReadOnly: true,
                        Source: "/host/data/clock/.runtime/token",
                        Target: PLUGIN_CONTAINER_TOKEN_PATH,
                    },
                    {
                        ReadOnly: true,
                        Source: "/host/rig/typebox",
                        Target: PLUGIN_CONTAINER_TYPEBOX_DIRECTORY,
                    },
                ],
                NetworkMode: "none",
                PidsLimit: 512,
                Privileged: false,
                ReadonlyRootfs: true,
                SecurityOpt: ["no-new-privileges:true"],
                Tmpfs: { "/tmp": expect.any(String) },
            },
            Image: "clock:local",
            WorkingDir: PLUGIN_CONTAINER_DATA_DIRECTORY,
        });
        expect(options.Env).toEqual(
            expect.arrayContaining([
                "PATH=/usr/local/bin:/usr/bin",
                `HOME=${PLUGIN_CONTAINER_DATA_DIRECTORY}`,
                "TMPDIR=/tmp",
                "LANG=en_US.UTF-8",
                `HAPPY_PLUGIN_DIRECTORY=${PLUGIN_CONTAINER_DATA_DIRECTORY}`,
                `HAPPY_PLUGIN_SOCKET_PATH=${PLUGIN_CONTAINER_DATA_DIRECTORY}/.runtime/plugin.sock`,
            ]),
        );
        expect(options.Env).not.toContain("PATH=/host/bin");
        expect(options.Env).not.toContain("HOME=/Users/steve");
        expect(options.Env).not.toContain("SHARED_VALUE=passed-through");
        expect(options.Env).not.toContain("ANTHROPIC_API_KEY=must-not-leak");
        expect(options.Env?.some((value) => value.startsWith("HAPPY_PLUGIN_TOKEN="))).toBe(false);
    });

    it("derives a deterministic container name from the folder and runtime generation", () => {
        const input = {
            directory: "/host/plugins/clock",
            folderName: "Clock Plugin",
            image: "clock:first",
        };

        expect(createPluginDockerContainerName(input)).toBe(createPluginDockerContainerName(input));
        expect(createPluginDockerContainerName(input)).not.toBe(
            createPluginDockerContainerName({ ...input, image: "clock:second" }),
        );
    });

    it("constructs the Docker Desktop socket bridge without changing the plugin command", () => {
        const options = createPluginDockerContainerOptions({
            bootstrapPath: "/host/rig/plugin-docker-bootstrap.js",
            codeDirectory: "/host/plugins/clock",
            containerName: "rig-plugin-clock-generation",
            dataDirectory: "/host/data/clock",
            entryPath: "index.ts",
            environment: {},
            folderName: "clock",
            image: "clock:local",
            loaderPath: "/host/rig/happyPluginsLoader.ts",
            sdkModuleDirectory: "/host/rig/plugin-sdk",
            socketBridgePort: 31_337,
            tokenFilePath: "/host/data/clock/.runtime/token",
            typeboxModuleDirectory: "/host/rig/typebox",
        });

        expect(options.Cmd).toEqual([
            PLUGIN_CONTAINER_BOOTSTRAP_PATH,
            "31337",
            "--import",
            expect.stringContaining("/happy-plugin-runtime/plugin-loader.ts"),
            `${PLUGIN_CONTAINER_CODE_DIRECTORY}/index.ts`,
        ]);
        expect(options.HostConfig).toMatchObject({
            ExtraHosts: ["host.docker.internal:host-gateway"],
            Mounts: expect.arrayContaining([
                expect.objectContaining({
                    ReadOnly: true,
                    Source: "/host/rig/plugin-docker-bootstrap.js",
                    Target: PLUGIN_CONTAINER_BOOTSTRAP_PATH,
                }),
            ]),
        });
        expect(options.Env).toContain("HAPPY_PLUGIN_SOCKET_PATH=/tmp/happy-plugin.sock");
    });

    it("runs as the explicitly mapped host user on native Linux", () => {
        const options = createPluginDockerContainerOptions({
            bootstrapPath: "/host/rig/plugin-docker-bootstrap.js",
            codeDirectory: "/host/plugins/clock",
            containerName: "rig-plugin-clock-generation",
            dataDirectory: "/host/data/clock",
            entryPath: "index.ts",
            environment: {},
            folderName: "clock",
            image: "clock:local",
            loaderPath: "/host/rig/plugin-sdk-loader.js",
            sdkModuleDirectory: "/host/rig/plugin-sdk",
            tokenFilePath: "/host/data/clock/.runtime/token",
            typeboxModuleDirectory: "/host/rig/typebox",
            user: "501:20",
        });

        expect(options.User).toBe("501:20");
    });
});

describe("Docker plugin socket bridge", () => {
    it("rejects an incorrect generation token and returns only authenticated payload bytes", () => {
        expect(
            readPluginDockerBridgeAuthentication(
                Buffer.from("generation-secrexrequest"),
                "generation-secret",
            ),
        ).toBeUndefined();
        expect(
            readPluginDockerBridgeAuthentication(
                Buffer.from("generation-secretrequest"),
                "generation-secret",
            )?.toString("utf8"),
        ).toBe("request");
    });

    it("keeps an established idle stream alive after the handshake timeout window", () => {
        let timeoutHandler = () => {};
        const socket = {
            destroy: vi.fn(),
            setTimeout: vi.fn((timeoutMs: number, listener?: () => void) => {
                if (timeoutMs > 0 && listener !== undefined) timeoutHandler = listener;
                return socket;
            }),
        };

        const markEstablished = armPluginDockerBridgeHandshakeTimeout(socket as never, 25);
        markEstablished();
        timeoutHandler();

        expect(socket.setTimeout).toHaveBeenLastCalledWith(0);
        expect(socket.destroy).not.toHaveBeenCalled();
    });

    it("destroys a connection that never completes its handshake", () => {
        let timeoutHandler = () => {};
        const socket = {
            destroy: vi.fn(),
            setTimeout: vi.fn((timeoutMs: number, listener?: () => void) => {
                if (timeoutMs > 0 && listener !== undefined) timeoutHandler = listener;
                return socket;
            }),
        };

        armPluginDockerBridgeHandshakeTimeout(socket as never, 25);
        timeoutHandler();

        expect(socket.destroy).toHaveBeenCalledOnce();
    });
});

describe("Docker plugin image preparation", () => {
    it("does not rebuild a content-addressed Dockerfile image that is already local", async () => {
        const directory = await createPlugin({ dockerfile: "FROM node:24-alpine\n" });
        const plugin = await readPluginManifest(directory);
        const buildImage = vi.fn();
        const docker = {
            buildImage,
            getImage: () => ({ inspect: async () => ({}) }),
        } as unknown as Dockerode;

        await preparePluginDockerImage(plugin, { docker });

        expect(buildImage).not.toHaveBeenCalled();
        await expect(readFile(join(directory, "plugin.log"), "utf8")).resolves.toContain(
            "is already prepared",
        );
    });

    it("packs exactly the files used by the deterministic content hash", async () => {
        const directory = await createPlugin({ dockerfile: "FROM node:24-alpine\n" });
        await mkdir(join(directory, "node_modules", "fixture"), { recursive: true });
        await writeFile(join(directory, "node_modules", "fixture", "index.js"), "first\n");
        const first = await readPluginManifest(directory);
        const firstImage = await resolvePluginDockerImage(first);
        await writeFile(join(directory, "node_modules", "fixture", "index.js"), "second\n");
        const second = await readPluginManifest(directory);
        const secondImage = await resolvePluginDockerImage(second);
        expect(secondImage).not.toBe(firstImage);

        const buildImage = vi.fn(async () => Readable.from([]));
        const docker = {
            buildImage,
            getImage: () => ({
                inspect: async () => Promise.reject({ statusCode: 404 }),
            }),
            modem: {
                followProgress: (
                    _stream: NodeJS.ReadableStream,
                    finished: (error?: unknown) => void,
                ) => finished(),
            },
        } as unknown as Dockerode;
        await preparePluginDockerImage(second, { docker });
        expect(buildImage).toHaveBeenCalledWith(
            {
                context: directory,
                src: expect.arrayContaining([
                    "Dockerfile",
                    "happy.plugin.json",
                    "node_modules/fixture/index.js",
                ]),
            },
            expect.objectContaining({
                labels: expect.any(Object),
                t: secondImage,
            }),
        );
    });

    it("pulls a declared prebuilt image only when it is absent", async () => {
        const directory = await createPlugin({
            docker: { image: "registry.example.com/happy/clock:1.2.3" },
        });
        const plugin = await readPluginManifest(directory);
        const pull = vi.fn(async () => Readable.from([]));
        const docker = {
            getImage: () => ({
                inspect: async () => Promise.reject({ statusCode: 404 }),
            }),
            modem: {
                followProgress: (
                    _stream: NodeJS.ReadableStream,
                    finished: (error?: unknown) => void,
                    progress: (event: unknown) => void,
                ) => {
                    progress({ status: "Pull complete" });
                    finished();
                },
            },
            pull,
        } as unknown as Dockerode;

        await preparePluginDockerImage(plugin, { docker });

        expect(pull).toHaveBeenCalledWith("registry.example.com/happy/clock:1.2.3");
        await expect(readFile(join(directory, "plugin.log"), "utf8")).resolves.toContain(
            "Pull complete",
        );
    });
});

describe("Docker plugin startup failures", () => {
    it("reports an unavailable Docker daemon in human-readable terms", async () => {
        const directory = await createPlugin({
            docker: { image: "registry.example.com/happy/clock:1.2.3" },
        });
        const plugin = await readPluginManifest(directory);
        const docker = {
            listContainers: async () => [],
            getContainer: () => ({
                inspect: async () => Promise.reject({ statusCode: 404 }),
            }),
            getImage: () => ({
                inspect: async () => Promise.reject(new Error("connect ENOENT docker.sock")),
            }),
        } as unknown as Dockerode;

        await expect(
            startPluginDockerContainer({
                dataDirectory: join(directory, "data"),
                docker,
                environment: {},
                plugin,
                token: "secret-token",
            }),
        ).rejects.toThrow(
            "Rig could not inspect the Docker resources needed to start the Clock plugin: connect ENOENT docker.sock",
        );
    });

    it("preserves Docker's mount-denial detail when container creation fails", async () => {
        const directory = await createPlugin({
            docker: { image: "registry.example.com/happy/clock:1.2.3" },
        });
        const plugin = await readPluginManifest(directory);
        const dataDirectory = join(directory, "data");
        await mkdir(join(dataDirectory, ".runtime"), { recursive: true });
        const docker = {
            createContainer: async () =>
                Promise.reject(
                    new Error(
                        "Mounts denied: the path /opt/happy/plugin-sdk is not shared from the host.",
                    ),
                ),
            getContainer: () => ({
                inspect: async () => Promise.reject({ statusCode: 404 }),
            }),
            getImage: () => ({
                inspect: async () => ({ Config: { Env: [] } }),
            }),
            listContainers: async () => [],
        } as unknown as Dockerode;

        await expect(
            startPluginDockerContainer({
                dataDirectory,
                docker,
                environment: {},
                plugin,
                token: "secret-token",
            }),
        ).rejects.toThrow(
            "Rig could not create the Clock plugin container: Mounts denied: the path /opt/happy/plugin-sdk is not shared from the host.",
        );
    });

    it("bounds container and image cleanup when Docker never answers", async () => {
        vi.useFakeTimers();
        const docker = {
            listContainers: () => new Promise<never>(() => {}),
            listImages: () => new Promise<never>(() => {}),
        } as unknown as Dockerode;
        const containers = removePluginDockerContainers("clock", {
            docker,
            timeoutMs: 25,
        });
        const images = removePluginDockerImages("clock", {
            docker,
            timeoutMs: 25,
        });
        const containersAssertion = expect(containers).rejects.toThrow(
            "Removing Docker containers for the clock plugin did not finish within 25 milliseconds.",
        );
        const imagesAssertion = expect(images).rejects.toThrow(
            "Removing Docker images for the clock plugin did not finish within 25 milliseconds.",
        );

        await vi.advanceTimersByTimeAsync(25);

        await containersAssertion;
        await imagesAssertion;
    });

    it("applies a deterministic deadline to a never-resolving Docker operation", async () => {
        vi.useFakeTimers();
        const operation = withPluginDockerDeadline(new Promise<never>(() => {}), {
            action: "Removing a Docker test resource",
            timeoutMs: 25,
        });
        const assertion = expect(operation).rejects.toThrow(
            "Removing a Docker test resource did not finish within 25 milliseconds.",
        );

        await vi.advanceTimersByTimeAsync(25);

        await assertion;
    });

    it("reaps every owned stale generation and lets a force close supersede a hung stop", async () => {
        const directory = await createPlugin({
            docker: { image: "registry.example.com/happy/clock:1.2.3" },
        });
        const plugin = await readPluginManifest(directory);
        const dataDirectory = join(directory, "data");
        await mkdir(join(dataDirectory, ".runtime"), { recursive: true });
        const output = new PassThrough();
        const stop = vi.fn(() => new Promise<void>(() => {}));
        const removeCurrent = vi.fn(async () => {});
        const removeNamedGeneration = vi.fn(async () => {});
        const removeStale = vi.fn(async () => {});
        const currentContainer = {
            attach: async () => output,
            modem: { demuxStream: () => {} },
            remove: removeCurrent,
            start: async () => {},
            stop,
            wait: () => new Promise<unknown>(() => {}),
        };
        const containerName = createPluginDockerContainerName({
            directory: plugin.directory,
            folderName: plugin.folderName,
            image: await resolvePluginDockerImage(plugin),
        });
        const identity = createPluginDockerFolderIdentity(plugin.folderName);
        const docker = {
            createContainer: async () => currentContainer,
            getContainer: (name: string) =>
                name === "stale-generation"
                    ? { remove: removeStale }
                    : name === containerName
                      ? {
                            inspect: async () => ({
                                Config: {
                                    Labels: {
                                        [PLUGIN_DOCKER_MANAGED_LABEL]: "true",
                                        [PLUGIN_DOCKER_FOLDER_LABEL]: identity,
                                    },
                                },
                            }),
                            remove: removeNamedGeneration,
                        }
                      : currentContainer,
            getImage: () => ({
                inspect: async () => ({ Config: { Env: [] } }),
            }),
            listContainers: async () => [
                {
                    Id: "stale-generation",
                    Labels: {
                        [PLUGIN_DOCKER_MANAGED_LABEL]: "true",
                        [PLUGIN_DOCKER_FOLDER_LABEL]: identity,
                    },
                },
            ],
        } as unknown as Dockerode;

        const running = await startPluginDockerContainer({
            dataDirectory,
            docker,
            environment: {},
            plugin,
            token: "secret-token",
        });
        expect(removeStale).toHaveBeenCalledWith({ force: true });
        expect(removeNamedGeneration).toHaveBeenCalledWith({ force: true });

        void running.close().catch(() => {});
        await vi.waitFor(() => expect(stop).toHaveBeenCalledWith({ t: 2 }));
        await expect(running.close({ force: true })).resolves.toBeUndefined();
        expect(removeCurrent).toHaveBeenCalledWith({ force: true });
    });
});

async function createPlugin(options: {
    docker?: true | { image: string };
    dockerfile?: string;
}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-plugin-docker-manifest-"));
    temporaryDirectories.push(root);
    const directory = join(root, "clock");
    await mkdir(directory);
    await Promise.all([
        writeFile(
            join(directory, "happy.plugin.json"),
            `${JSON.stringify(
                {
                    author: "Happy",
                    category: "developer-tools",
                    description: "A container clock.",
                    ...(options.docker === undefined ? {} : { docker: options.docker }),
                    icon: "icon.png",
                    main: "index.ts",
                    name: "Clock",
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(directory, "icon.png"), PNG_SIGNATURE),
        writeFile(join(directory, "index.ts"), 'console.log("clock");\n'),
        ...(options.dockerfile === undefined
            ? []
            : [writeFile(join(directory, "Dockerfile"), options.dockerfile)]),
    ]);
    return directory;
}
