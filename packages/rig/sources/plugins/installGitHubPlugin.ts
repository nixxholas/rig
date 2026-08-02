import { randomUUID } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import type Dockerode from "dockerode";
import { extract as extractTar } from "tar-stream";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { discoverGitHubPlugins } from "./discoverGitHubPlugins.js";
import {
    fetchBoundedGitHubResource,
    GitHubResourceFetchError,
    type GitHubFetch,
} from "./fetchBoundedGitHubResource.js";
import {
    githubPluginInstallSourceSchema,
    type GitHubPluginCatalogEntry,
    type GitHubPluginInstallSource,
} from "./githubPluginCatalog.js";
import { installPluginFromPath, type InstalledPlugin } from "./installPluginFromPath.js";

const MAXIMUM_ARCHIVE_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAXIMUM_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_EXTRACTED_PLUGIN_BYTES = 32 * 1024 * 1024;
const MAXIMUM_EXTRACTED_PLUGIN_FILES = 2_000;
const MAXIMUM_EXTRACTED_PLUGIN_ENTRIES = 4_000;

export async function installGitHubPlugin(options: {
    docker?: Dockerode;
    fetcher?: GitHubFetch;
    fs: FileSystemContext;
    pluginsDirectory: string;
    signal?: AbortSignal;
    source: GitHubPluginInstallSource;
}): Promise<InstalledPlugin> {
    let source: GitHubPluginInstallSource;
    try {
        source = Value.Decode(githubPluginInstallSourceSchema, options.source);
    } catch {
        throw new Error(
            "A GitHub plugin installation needs a repository in owner/repo form, a plugin name, and a valid optional git ref.",
        );
    }
    const catalog = await discoverGitHubPlugins(
        {
            ...(source.ref === undefined ? {} : { ref: source.ref }),
            repository: source.repository,
        },
        {
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
    );
    const wanted = source.plugin.toLowerCase();
    const plugin = catalog.plugins.find((entry) => entry.name.toLowerCase() === wanted);
    if (plugin === undefined) {
        const available = catalog.plugins.map((entry) => entry.name);
        throw new Error(
            available.length === 0
                ? `The GitHub repository ${source.repository} does not list any plugins.`
                : `The GitHub repository ${source.repository} does not list a plugin named ${source.plugin}. Available plugins: ${available.join(", ")}.`,
        );
    }

    const archiveUrl = `https://api.github.com/repos/${source.repository}/tarball${source.ref === undefined ? "" : `/${source.ref}`}`;
    let archive: Uint8Array;
    try {
        archive = await fetchBoundedGitHubResource({
            accept: "application/vnd.github+json",
            description: `the repository archive for ${source.repository}`,
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            maximumBytes: MAXIMUM_ARCHIVE_DOWNLOAD_BYTES,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            url: archiveUrl,
        });
    } catch (error) {
        if (error instanceof GitHubResourceFetchError && error.status === 404) {
            throw new Error(
                `GitHub could not find ${source.repository} at ${source.ref ?? "its default branch"}.`,
            );
        }
        throw error;
    }

    options.signal?.throwIfAborted();
    const stagingRoot = join(options.pluginsDirectory, `.github-${randomUUID()}`);
    const sourceDirectory = join(stagingRoot, plugin.name);
    await options.fs.mkdir(sourceDirectory, { recursive: true });
    try {
        await extractPluginDirectory({
            archive,
            destination: sourceDirectory,
            fs: options.fs,
            plugin,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return await installPluginFromPath({
            ...(options.docker === undefined ? {} : { docker: options.docker }),
            fs: options.fs,
            pluginsDirectory: options.pluginsDirectory,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            sourceDirectory,
        });
    } finally {
        await options.fs.rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
    }
}

async function extractPluginDirectory(options: {
    archive: Uint8Array;
    destination: string;
    fs: FileSystemContext;
    plugin: GitHubPluginCatalogEntry;
    signal?: AbortSignal;
}): Promise<void> {
    const target = options.plugin.path.split("/");
    const budget = { bytes: 0, entries: 0, files: 0 };
    let expandedBytes = 0;
    let found = false;
    const expansionLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            expandedBytes += chunk.byteLength;
            if (expandedBytes > MAXIMUM_EXPANDED_ARCHIVE_BYTES) {
                callback(
                    new Error(
                        "The GitHub repository archive expands beyond Rig's 256 MB safety limit.",
                    ),
                );
                return;
            }
            callback(null, chunk);
        },
    });
    const extractor = extractTar();
    extractor.on("entry", (header, stream, next) => {
        void handleArchiveEntry({
            budget,
            destination: options.destination,
            fs: options.fs,
            header: {
                name: header.name,
                ...(header.size === undefined ? {} : { size: header.size }),
                ...(header.type === undefined ? {} : { type: header.type }),
            },
            onFound: () => {
                found = true;
            },
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            stream,
            target,
        }).then(next, (error: unknown) => {
            extractor.destroy(error instanceof Error ? error : new Error(String(error)));
        });
    });
    try {
        await pipeline(Readable.from([options.archive]), createGunzip(), expansionLimit, extractor);
    } catch (error) {
        if (options.signal?.aborted === true) options.signal.throwIfAborted();
        throw new Error(
            `Rig could not extract the ${options.plugin.displayName} plugin from the GitHub archive: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!found) {
        throw new Error(
            `The GitHub archive does not contain the indexed plugin folder ${options.plugin.path}.`,
        );
    }
}

async function handleArchiveEntry(options: {
    budget: { bytes: number; entries: number; files: number };
    destination: string;
    fs: FileSystemContext;
    header: { name: string; size?: number; type?: string | null };
    onFound: () => void;
    signal?: AbortSignal;
    stream: NodeJS.ReadableStream;
    target: readonly string[];
}): Promise<void> {
    options.signal?.throwIfAborted();
    const parts = archivePathParts(options.header.name);
    const repositoryRelative = parts.slice(1);
    if (!startsWithPath(repositoryRelative, options.target)) {
        await drain(options.stream, options.signal);
        return;
    }
    options.onFound();
    options.budget.entries += 1;
    if (options.budget.entries > MAXIMUM_EXTRACTED_PLUGIN_ENTRIES) {
        throw new Error("A GitHub plugin archive may contain at most 4,000 selected entries.");
    }
    const relative = repositoryRelative.slice(options.target.length);
    if (relative.length === 0) {
        if (options.header.type !== "directory") {
            throw new Error(
                `The indexed plugin path ${options.target.join("/")} is not a folder in the GitHub archive.`,
            );
        }
        await drain(options.stream, options.signal);
        return;
    }
    const destination = join(options.destination, ...relative);
    if (options.header.type === "directory") {
        await options.fs.mkdir(destination, { recursive: true });
        await drain(options.stream, options.signal);
        return;
    }
    if (options.header.type !== "file") {
        throw new Error(
            `The indexed plugin folder contains an unsupported ${options.header.type ?? "archive"} entry at ${relative.join("/")}.`,
        );
    }
    options.budget.files += 1;
    if (options.budget.files > MAXIMUM_EXTRACTED_PLUGIN_FILES) {
        throw new Error("A GitHub plugin may contain at most 2,000 files.");
    }
    if (
        options.header.size === undefined ||
        !Number.isSafeInteger(options.header.size) ||
        options.header.size < 0 ||
        options.budget.bytes + options.header.size > MAXIMUM_EXTRACTED_PLUGIN_BYTES
    ) {
        throw new Error("A GitHub plugin may contain at most 32 MB of extracted files.");
    }

    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of options.stream) {
        options.signal?.throwIfAborted();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        length += chunk.byteLength;
        if (options.budget.bytes + length > MAXIMUM_EXTRACTED_PLUGIN_BYTES) {
            throw new Error("A GitHub plugin may contain at most 32 MB of extracted files.");
        }
        chunks.push(chunk);
    }
    options.budget.bytes += length;
    await options.fs.mkdir(dirname(destination), { recursive: true });
    await options.fs.writeFile(destination, Buffer.concat(chunks, length));
}

function archivePathParts(path: string): string[] {
    if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
        throw new Error("The GitHub archive contains an unsafe file path.");
    }
    const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
    const parts = withoutTrailingSlash.split("/");
    if (
        parts.length < 1 ||
        parts.some((part) => part.length === 0 || part === "." || part === "..")
    ) {
        throw new Error("The GitHub archive contains an unsafe file path.");
    }
    return parts;
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
    return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

async function drain(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<void> {
    for await (const _chunk of stream) {
        signal?.throwIfAborted();
        // Tar entries must be consumed before the extractor can continue.
    }
}
