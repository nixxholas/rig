import { join } from "node:path";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Dockerode from "dockerode";

import { errorToMessage } from "../errorToMessage.js";
import { isDockerNotFoundError } from "../execution/isDockerNotFoundError.js";
import { PluginLog } from "./PluginLog.js";
import {
    createPluginDockerFolderIdentity,
    PLUGIN_DOCKER_FOLDER_LABEL,
    PLUGIN_DOCKER_MANAGED_LABEL,
} from "./pluginDockerOwnership.js";
import {
    listPluginDockerBuildContextFiles,
    resolvePluginDockerImage,
} from "./resolvePluginDockerRuntime.js";
import type { RegisteredPlugin } from "./types.js";
import {
    PLUGIN_DOCKER_CLEANUP_TIMEOUT_MS,
    withPluginDockerDeadline,
} from "./withPluginDockerDeadline.js";

const dockerProgressEventSchema = Type.Object(
    {
        error: Type.Optional(Type.String()),
        errorDetail: Type.Optional(
            Type.Object(
                {
                    message: Type.Optional(Type.String()),
                },
                { additionalProperties: true },
            ),
        ),
        progress: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        stream: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);
type DockerProgressEvent = Static<typeof dockerProgressEventSchema>;
const dockerImageListSchema = Type.Array(
    Type.Object(
        {
            Id: Type.String({ minLength: 1 }),
            Labels: Type.Optional(Type.Record(Type.String(), Type.String())),
            RepoTags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        },
        { additionalProperties: true },
    ),
);

export async function preparePluginDockerImage(
    plugin: RegisteredPlugin,
    options: { docker?: Dockerode; signal?: AbortSignal } = {},
): Promise<void> {
    if (plugin.docker === undefined) return;
    options.signal?.throwIfAborted();
    const docker = options.docker ?? new Dockerode();
    const image = await resolvePluginDockerImage(plugin);
    const log = new PluginLog({ path: join(plugin.directory, "plugin.log") });
    try {
        if (plugin.docker.type === "dockerfile") {
            if (await imageExists(docker, image)) {
                log.append("stdout", Buffer.from(`Docker image ${image} is already prepared.\n`));
                return;
            }
            log.append("stdout", Buffer.from(`Building Docker image ${image}.\n`));
            const entries = await listPluginDockerBuildContextFiles(plugin.directory);
            const stream = await docker.buildImage(
                { context: plugin.directory, src: entries },
                {
                    dockerfile: "Dockerfile",
                    labels: {
                        [PLUGIN_DOCKER_MANAGED_LABEL]: "true",
                        [PLUGIN_DOCKER_FOLDER_LABEL]: createPluginDockerFolderIdentity(
                            plugin.folderName,
                        ),
                    },
                    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
                    rm: true,
                    t: image,
                    version: "1",
                },
            );
            await followDockerProgress(docker, stream, log);
            return;
        }
        if (await imageExists(docker, image)) {
            log.append("stdout", Buffer.from(`Docker image ${image} is already available.\n`));
            return;
        }
        log.append("stdout", Buffer.from(`Pulling Docker image ${image}.\n`));
        const stream = await docker.pull(image);
        await followDockerProgress(docker, stream, log);
    } catch (error) {
        const action = plugin.docker.type === "dockerfile" ? "build" : "pull";
        const message = `Rig could not ${action} Docker image '${image}' for the ${plugin.manifest.name} plugin: ${errorToMessage(error)}`;
        log.append("stderr", Buffer.from(`${message}\n`));
        throw new Error(message);
    } finally {
        await log.close();
    }
}

export async function removePluginDockerImages(
    folderName: string,
    options: { docker?: Dockerode; keepImage?: string; timeoutMs?: number } = {},
): Promise<void> {
    const docker = options.docker ?? new Dockerode();
    const timeoutMs = options.timeoutMs ?? PLUGIN_DOCKER_CLEANUP_TIMEOUT_MS;
    await withPluginDockerDeadline(
        removeOwnedPluginDockerImages(folderName, docker, options.keepImage),
        {
            action: `Removing Docker images for the ${folderName} plugin`,
            timeoutMs,
        },
    );
}

async function removeOwnedPluginDockerImages(
    folderName: string,
    docker: Dockerode,
    keepImage: string | undefined,
): Promise<void> {
    const identity = createPluginDockerFolderIdentity(folderName);
    const listed: unknown = await docker.listImages({
        all: true,
        filters: {
            label: [
                `${PLUGIN_DOCKER_MANAGED_LABEL}=true`,
                `${PLUGIN_DOCKER_FOLDER_LABEL}=${identity}`,
            ],
        },
    });
    if (!Value.Check(dockerImageListSchema, listed)) {
        throw new Error("Docker returned an invalid plugin image list.");
    }
    await Promise.all(
        listed.map(async (candidate) => {
            if (
                candidate.Labels?.[PLUGIN_DOCKER_MANAGED_LABEL] !== "true" ||
                candidate.Labels[PLUGIN_DOCKER_FOLDER_LABEL] !== identity ||
                candidate.RepoTags?.includes(keepImage ?? "") === true
            ) {
                return;
            }
            await docker
                .getImage(candidate.Id)
                .remove({ force: true })
                .catch((error: unknown) => {
                    if (!isDockerNotFoundError(error)) throw error;
                });
        }),
    );
}

async function imageExists(docker: Dockerode, image: string): Promise<boolean> {
    try {
        await docker.getImage(image).inspect();
        return true;
    } catch (error) {
        if (isDockerNotFoundError(error)) return false;
        throw error;
    }
}

function followDockerProgress(
    docker: Dockerode,
    stream: NodeJS.ReadableStream,
    log: PluginLog,
): Promise<void> {
    return new Promise((resolve, reject) => {
        docker.modem.followProgress(
            stream,
            (error: unknown) => {
                if (error === null || error === undefined) resolve();
                else reject(error);
            },
            (value: unknown) => {
                if (!Value.Check(dockerProgressEventSchema, value)) return;
                appendProgress(log, value);
            },
        );
    });
}

function appendProgress(log: PluginLog, event: DockerProgressEvent): void {
    if (event.stream !== undefined) {
        log.append("stdout", Buffer.from(event.stream));
        return;
    }
    const error = event.errorDetail?.message ?? event.error;
    if (error !== undefined) {
        log.append("stderr", Buffer.from(`${error}\n`));
        return;
    }
    if (event.status !== undefined) {
        log.append(
            "stdout",
            Buffer.from(
                `${event.status}${event.progress === undefined ? "" : ` ${event.progress}`}\n`,
            ),
        );
    }
}
