import { createHash } from "node:crypto";
import { extname } from "node:path";

import type Dockerode from "dockerode";

import {
    createPluginDockerFolderIdentity,
    PLUGIN_DOCKER_FOLDER_LABEL,
    PLUGIN_DOCKER_MANAGED_LABEL,
} from "./pluginDockerOwnership.js";

export const PLUGIN_CONTAINER_CODE_DIRECTORY = "/plugin";
export const PLUGIN_CONTAINER_DATA_DIRECTORY = "/plugin-data";
export const PLUGIN_CONTAINER_RUNTIME_DIRECTORY = "/happy-plugin-runtime";
export const PLUGIN_CONTAINER_BOOTSTRAP_PATH = `${PLUGIN_CONTAINER_RUNTIME_DIRECTORY}/plugin-docker-bootstrap.js`;
export const PLUGIN_CONTAINER_LOADER_PATH = `${PLUGIN_CONTAINER_RUNTIME_DIRECTORY}/plugin-loader.js`;
export const PLUGIN_CONTAINER_SDK_DIRECTORY = `${PLUGIN_CONTAINER_RUNTIME_DIRECTORY}/plugin-sdk`;
export const PLUGIN_CONTAINER_TOKEN_PATH = `${PLUGIN_CONTAINER_RUNTIME_DIRECTORY}/plugin-token`;
export const PLUGIN_CONTAINER_TYPEBOX_DIRECTORY = `${PLUGIN_CONTAINER_RUNTIME_DIRECTORY}/node_modules/@sinclair/typebox`;

const SAFE_HOST_ENVIRONMENT_NAMES = new Set([
    "COLORTERM",
    "FORCE_COLOR",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "TERM",
    "TZ",
]);
const PLUGIN_CONTAINER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const PLUGIN_CONTAINER_PROCESS_LIMIT = 512;

export function createPluginDockerContainerName(options: {
    directory: string;
    folderName: string;
    image: string;
}): string {
    const folder =
        options.folderName
            .toLowerCase()
            .replace(/[^a-z0-9_.-]+/gu, "-")
            .replace(/^[.-]+|[.-]+$/gu, "")
            .slice(0, 40) || "plugin";
    const generation = createHash("sha256")
        .update(options.directory)
        .update("\0")
        .update(options.image)
        .digest("hex")
        .slice(0, 12);
    return `rig-plugin-${folder}-${generation}`;
}

export function createPluginDockerContainerOptions(options: {
    bootstrapPath: string;
    codeDirectory: string;
    containerName: string;
    dataDirectory: string;
    entryPath: string;
    environment: NodeJS.ProcessEnv;
    folderName: string;
    image: string;
    imageEnvironment?: readonly string[];
    loaderPath: string;
    sdkModuleDirectory: string;
    socketBridgePort?: number;
    tokenFilePath: string;
    typeboxModuleDirectory: string;
    user?: string;
}): Dockerode.ContainerCreateOptions {
    const containerLoaderPath = containerRuntimeFilePath("plugin-loader", options.loaderPath);
    const containerBootstrapPath = containerRuntimeFilePath(
        "plugin-docker-bootstrap",
        options.bootstrapPath,
    );
    const loaderUrl = new URL(`file://${containerLoaderPath}`);
    loaderUrl.searchParams.set("sdk", PLUGIN_CONTAINER_SDK_DIRECTORY);
    const entryPath = `${PLUGIN_CONTAINER_CODE_DIRECTORY}/${options.entryPath.replaceAll("\\", "/")}`;
    return {
        name: options.containerName,
        AttachStderr: true,
        AttachStdout: true,
        Cmd: [
            containerBootstrapPath,
            String(options.socketBridgePort ?? 0),
            "--import",
            loaderUrl.href,
            entryPath,
        ],
        Entrypoint: ["node"],
        Env: createContainerEnvironment(options),
        HostConfig: {
            AutoRemove: false,
            CapDrop: ["ALL"],
            ...(options.socketBridgePort === undefined
                ? {}
                : { ExtraHosts: ["host.docker.internal:host-gateway"] }),
            Init: true,
            Memory: PLUGIN_CONTAINER_MEMORY_BYTES,
            Mounts: [
                {
                    ReadOnly: true,
                    Source: options.codeDirectory,
                    Target: PLUGIN_CONTAINER_CODE_DIRECTORY,
                    Type: "bind",
                },
                {
                    ReadOnly: false,
                    Source: options.dataDirectory,
                    Target: PLUGIN_CONTAINER_DATA_DIRECTORY,
                    Type: "bind",
                },
                {
                    ReadOnly: true,
                    Source: options.loaderPath,
                    Target: containerLoaderPath,
                    Type: "bind",
                },
                {
                    ReadOnly: true,
                    Source: options.sdkModuleDirectory,
                    Target: PLUGIN_CONTAINER_SDK_DIRECTORY,
                    Type: "bind",
                },
                {
                    ReadOnly: true,
                    Source: options.bootstrapPath,
                    Target: containerBootstrapPath,
                    Type: "bind",
                },
                {
                    ReadOnly: true,
                    Source: options.tokenFilePath,
                    Target: PLUGIN_CONTAINER_TOKEN_PATH,
                    Type: "bind",
                },
                {
                    ReadOnly: true,
                    Source: options.typeboxModuleDirectory,
                    Target: PLUGIN_CONTAINER_TYPEBOX_DIRECTORY,
                    Type: "bind",
                },
            ],
            NetworkMode: options.socketBridgePort === undefined ? "none" : "bridge",
            PidsLimit: PLUGIN_CONTAINER_PROCESS_LIMIT,
            Privileged: false,
            ReadonlyRootfs: true,
            SecurityOpt: ["no-new-privileges:true"],
            Tmpfs: {
                "/tmp": "rw,nosuid,nodev,noexec,size=67108864",
            },
        },
        Image: options.image,
        Labels: {
            [PLUGIN_DOCKER_MANAGED_LABEL]: "true",
            [PLUGIN_DOCKER_FOLDER_LABEL]: createPluginDockerFolderIdentity(options.folderName),
        },
        OpenStdin: false,
        Tty: false,
        ...(options.user === undefined ? {} : { User: options.user }),
        WorkingDir: PLUGIN_CONTAINER_DATA_DIRECTORY,
    };
}

function createContainerEnvironment(
    options: Pick<
        Parameters<typeof createPluginDockerContainerOptions>[0],
        "environment" | "imageEnvironment" | "socketBridgePort"
    >,
): string[] {
    const environment = new Map<string, string>();
    for (const value of options.imageEnvironment ?? []) {
        const separator = value.indexOf("=");
        if (separator > 0) environment.set(value.slice(0, separator), value.slice(separator + 1));
    }
    for (const [name, value] of Object.entries(options.environment)) {
        if (value !== undefined && SAFE_HOST_ENVIRONMENT_NAMES.has(name)) {
            environment.set(name, value);
        }
    }
    environment.delete("HAPPY_PLUGIN_TOKEN");
    environment.set("HOME", PLUGIN_CONTAINER_DATA_DIRECTORY);
    environment.set("TMPDIR", "/tmp");
    environment.set("TMP", "/tmp");
    environment.set("TEMP", "/tmp");
    environment.set("HAPPY_PLUGIN_DIRECTORY", PLUGIN_CONTAINER_DATA_DIRECTORY);
    environment.set(
        "HAPPY_PLUGIN_SOCKET_PATH",
        options.socketBridgePort === undefined
            ? `${PLUGIN_CONTAINER_DATA_DIRECTORY}/.runtime/plugin.sock`
            : "/tmp/happy-plugin.sock",
    );
    return [...environment].map(([name, value]) => `${name}=${value}`);
}

function containerRuntimeFilePath(name: string, hostPath: string): string {
    return `${PLUGIN_CONTAINER_RUNTIME_DIRECTORY}/${name}${extname(hostPath) === ".ts" ? ".ts" : ".js"}`;
}
