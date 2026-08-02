import { basename, join } from "node:path";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { buildPlugin } from "./buildPlugin.js";
import { readPluginManifest } from "./readPluginManifest.js";
import { PLUGIN_MANIFEST_FILE_NAME } from "./types.js";

/** Generated state never travels with a plugin; Rig rebuilds it for the installed copy. */
const EXCLUDED_ENTRIES = new Set([".build", ".git", ".runtime", "node_modules"]);
const MAX_SOURCE_FILES = 2_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export interface InstalledPlugin {
    description: string;
    directory: string;
    folder: string;
    name: string;
}

/**
 * Copies a plugin's sources into Rig's managed plugins folder and compiles them there.
 *
 * The copy lands in a hidden staging folder first, so a plugin that fails to build never becomes
 * visible to discovery and never replaces a working installation.
 */
export async function installPluginFromPath(options: {
    fs: FileSystemContext;
    pluginsDirectory: string;
    signal?: AbortSignal;
    sourceDirectory: string;
}): Promise<InstalledPlugin> {
    const { fs, pluginsDirectory, signal, sourceDirectory } = options;
    signal?.throwIfAborted();
    const sourceInfo = await fs.stat(sourceDirectory).catch(() => undefined);
    if (sourceInfo === undefined || !sourceInfo.isDirectory) {
        throw new Error(`${sourceDirectory} is not a folder that Rig can install a plugin from.`);
    }
    if (!(await fs.exists(join(sourceDirectory, PLUGIN_MANIFEST_FILE_NAME)))) {
        throw new Error(
            `${sourceDirectory} has no ${PLUGIN_MANIFEST_FILE_NAME}, so it is not a plugin.`,
        );
    }

    const folder = toFolderName(basename(sourceDirectory));
    const stagingDirectory = join(pluginsDirectory, `.installing-${folder}`);
    await fs.rm(stagingDirectory, { force: true, recursive: true });
    await fs.mkdir(stagingDirectory, { recursive: true });
    try {
        await copyTree(fs, sourceDirectory, stagingDirectory, signal);
        // Registration and compilation both run against the staged copy, so an invalid manifest,
        // an escaping asset, or a type error is reported before anything is installed.
        const staged = await readPluginManifest(stagingDirectory);
        await buildPlugin(staged);
        signal?.throwIfAborted();

        const directory = join(pluginsDirectory, folder);
        await fs.rm(directory, { force: true, recursive: true });
        await fs.move(stagingDirectory, directory);
        return {
            description: staged.manifest.description,
            directory,
            folder,
            name: staged.manifest.name,
        };
    } catch (error) {
        await fs.rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
        throw error;
    }
}

function toFolderName(value: string): string {
    const folder = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, "-")
        .replace(/^[.-]+|[.-]+$/gu, "");
    if (folder.length === 0) {
        throw new Error("A plugin folder must have a name Rig can install it under.");
    }
    return folder;
}

async function copyTree(
    fs: FileSystemContext,
    source: string,
    destination: string,
    signal?: AbortSignal,
): Promise<void> {
    const budget = { bytes: 0, files: 0 };
    await copyDirectory(fs, source, destination, budget, signal);
}

async function copyDirectory(
    fs: FileSystemContext,
    source: string,
    destination: string,
    budget: { bytes: number; files: number },
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
        signal?.throwIfAborted();
        if (EXCLUDED_ENTRIES.has(entry)) continue;
        const sourcePath = join(source, entry);
        const info = await fs.lstat(sourcePath);
        if (info.isSymbolicLink) {
            throw new Error(
                `Rig does not install ${entry} because a plugin may not contain symbolic links.`,
            );
        }
        if (info.isDirectory) {
            await copyDirectory(fs, sourcePath, join(destination, entry), budget, signal);
            continue;
        }
        if (!info.isFile) continue;
        budget.files += 1;
        budget.bytes += info.size;
        if (budget.files > MAX_SOURCE_FILES) {
            throw new Error(
                `Rig installs at most ${String(MAX_SOURCE_FILES)} files from a plugin folder.`,
            );
        }
        if (budget.bytes > MAX_SOURCE_BYTES) {
            throw new Error("Rig installs at most 32 MB of sources from a plugin folder.");
        }
        await fs.writeFile(join(destination, entry), await fs.readFileBuffer(sourcePath));
    }
}
