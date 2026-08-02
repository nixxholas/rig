import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { Value } from "@sinclair/typebox/value";
import type { HappyPluginDocker } from "happy-plugins";

import { fileSystemErrorSchema, type PluginDockerRuntime, type RegisteredPlugin } from "./types.js";

const DOCKERFILE_NAME = "Dockerfile";
const BUILD_CONTEXT_EXCLUDED_ENTRIES = new Set(["plugin.log", "plugin.log.next"]);
const MAXIMUM_BUILD_CONTEXT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_BUILD_CONTEXT_FILES = 2_000;

export async function resolvePluginDockerRuntime(options: {
    declaration: HappyPluginDocker | undefined;
    directory: string;
    hasMain: boolean;
}): Promise<PluginDockerRuntime | undefined> {
    const dockerfilePath = join(options.directory, DOCKERFILE_NAME);
    const dockerfileInfo = await lstat(dockerfilePath).catch((error: unknown) => {
        if (Value.Check(fileSystemErrorSchema, error) && error.code === "ENOENT") return undefined;
        throw error;
    });
    if (dockerfileInfo !== undefined) {
        if (!dockerfileInfo.isFile() || dockerfileInfo.isSymbolicLink()) {
            throw new Error("The plugin Dockerfile must be an ordinary file.");
        }
        if (options.declaration !== undefined && options.declaration !== true) {
            throw new Error(
                "A plugin with a Dockerfile cannot also declare docker.image. Remove one of them.",
            );
        }
        assertHasMain(options.hasMain);
        return {
            dockerfilePath,
            type: "dockerfile",
        };
    }
    if (options.declaration === undefined) return undefined;
    if (options.declaration === true) {
        throw new Error('The plugin declares "docker": true but its folder has no Dockerfile.');
    }
    assertHasMain(options.hasMain);
    return { image: options.declaration.image, type: "image" };
}

export async function resolvePluginDockerImage(plugin: RegisteredPlugin): Promise<string> {
    if (plugin.docker === undefined) {
        throw new Error(`The ${plugin.manifest.name} plugin does not declare a Docker runtime.`);
    }
    if (plugin.docker.type === "image") return plugin.docker.image;
    const contentHash = await hashDockerBuildContext(plugin.directory);
    return `rig-plugin-${normalizeImageName(plugin.folderName)}:${contentHash.slice(0, 24)}`;
}

async function hashDockerBuildContext(directory: string): Promise<string> {
    const hash = createHash("sha256");
    for (const relativePath of await listPluginDockerBuildContextFiles(directory)) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(await readFile(join(directory, relativePath)));
        hash.update("\0");
    }
    return hash.digest("hex");
}

export async function listPluginDockerBuildContextFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    await visit(directory, files, { bytes: 0, files: 0 });
    return files.map((path) => relative(directory, path).replaceAll("\\", "/")).sort();
}

async function visit(
    directory: string,
    files: string[],
    budget: { bytes: number; files: number },
): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (BUILD_CONTEXT_EXCLUDED_ENTRIES.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            await visit(path, files, budget);
        } else if (entry.isFile()) {
            const info = await lstat(path);
            budget.files += 1;
            budget.bytes += info.size;
            if (budget.files > MAXIMUM_BUILD_CONTEXT_FILES) {
                throw new Error("A Docker plugin build context may contain at most 2,000 files.");
            }
            if (budget.bytes > MAXIMUM_BUILD_CONTEXT_BYTES) {
                throw new Error("A Docker plugin build context may contain at most 32 MB.");
            }
            files.push(path);
        }
    }
}

function normalizeImageName(folderName: string): string {
    return (
        folderName
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/gu, "-")
            .replace(/^[.-]+|[.-]+$/gu, "")
            .slice(0, 48) || "plugin"
    );
}

function assertHasMain(hasMain: boolean): void {
    if (!hasMain) {
        throw new Error("A Docker plugin must declare a main entry point.");
    }
}
