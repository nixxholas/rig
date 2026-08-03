import { basename, join } from "node:path";

import type Dockerode from "dockerode";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import type { InstalledPluginSummary, PluginInstallClassification } from "../protocol/index.js";
import { comparePluginVersions } from "./comparePluginVersions.js";
import { preparePluginDockerImage } from "./preparePluginDockerImage.js";
import { readPluginManifest } from "./readPluginManifest.js";
import { PLUGIN_MANIFEST_FILE_NAME } from "./types.js";
import { PluginCatalogError } from "./PluginCatalogError.js";

/** Local and generated state never travels with a plugin. */
const EXCLUDED_ENTRIES = new Set([".git", ".runtime", "node_modules", "plugin.log"]);
const MAX_SOURCE_FILES = 2_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export type InstalledPlugin = InstalledPluginSummary;

/**
 * Copies a prebuilt plugin into Rig's managed plugins folder and validates it there.
 *
 * The copy lands in a hidden staging folder first, so an invalid plugin never becomes visible to
 * discovery and never replaces a working installation.
 */
export async function installPluginFromPath(options: {
    docker?: Dockerode;
    expectedVersion?: string;
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

    const folder = toPluginFolderName(basename(sourceDirectory));
    const stagingDirectory = join(pluginsDirectory, `.installing-${folder}`);
    await fs.rm(stagingDirectory, { force: true, recursive: true });
    await fs.mkdir(stagingDirectory, { recursive: true });
    try {
        await copyTree(fs, sourceDirectory, stagingDirectory, signal);
        // Registration runs against the staged copy, so an invalid manifest or escaping or missing
        // asset is reported before anything is installed.
        const staged = await readPluginManifest(stagingDirectory, { folderName: folder });
        if (
            options.expectedVersion !== undefined &&
            staged.manifest.version !== options.expectedVersion
        ) {
            throw new PluginCatalogError(
                "source_changed",
                `The selected package declares version ${options.expectedVersion}, but its plugin manifest declares ${staged.manifest.version}.`,
            );
        }
        await preparePluginDockerImage(staged, {
            ...(options.docker === undefined ? {} : { docker: options.docker }),
            ...(signal === undefined ? {} : { signal }),
        });
        signal?.throwIfAborted();

        const directory = join(pluginsDirectory, folder);
        const classification = await classifyInstall(fs, directory, staged.manifest.version);
        await fs.rm(directory, { force: true, recursive: true });
        await fs.move(stagingDirectory, directory);
        return {
            classification,
            description: staged.manifest.description,
            directory,
            folder,
            name: staged.manifest.name,
            version: staged.manifest.version,
        };
    } catch (error) {
        await fs.rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
        throw error;
    }
}

async function classifyInstall(
    fs: FileSystemContext,
    directory: string,
    nextVersion: string,
): Promise<PluginInstallClassification> {
    if (!(await fs.exists(directory))) return "fresh-install";
    // Version comparison is metadata, not a repair gate. A damaged or schema-outdated installed
    // copy must remain replaceable after the staged replacement has already validated successfully.
    const previousVersion = await readPluginManifest(directory)
        .then((plugin) => plugin.manifest.version)
        .catch(() => undefined);
    if (previousVersion === undefined) return "reinstall";
    const comparison = comparePluginVersions(nextVersion, previousVersion);
    return comparison === 0 ? "reinstall" : comparison > 0 ? "upgrade" : "downgrade";
}

export function toPluginFolderName(value: string): string {
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
