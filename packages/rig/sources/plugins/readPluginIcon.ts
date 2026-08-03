import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { HAPPY_PLUGIN_MAX_ICON_BYTES, HAPPY_PLUGIN_MAX_ICON_DIMENSION } from "happy-plugins";
import sharp from "sharp";

import type { PluginIconResource, PluginIconSummary } from "./types.js";

const MEBIBYTE = 1024 * 1024;
const MAXIMUM_CACHED_ICONS = 128;

interface CachedPluginIcon {
    key: string;
    summary: PluginIconSummary;
}

/** Bounded metadata cache for discovery and catalog status refreshes. */
export class PluginIconSummaryCache {
    readonly #entries = new Map<string, CachedPluginIcon>();

    async read(path: string, signal?: AbortSignal): Promise<PluginIconSummary> {
        const opened = await openOrdinaryIcon(path);
        try {
            const key = fileIdentity(opened.info);
            const cached = this.#entries.get(path);
            if (cached?.key === key) {
                this.#entries.delete(path);
                this.#entries.set(path, cached);
                return cached.summary;
            }
            const resource = await readAndValidate(opened.handle, opened.info, path, signal);
            const entry = { key, summary: summarize(resource) };
            this.#entries.delete(path);
            this.#entries.set(path, entry);
            while (this.#entries.size > MAXIMUM_CACHED_ICONS) {
                this.#entries.delete(this.#entries.keys().next().value!);
            }
            return entry.summary;
        } finally {
            await opened.handle.close();
        }
    }

    invalidate(path: string): void {
        this.#entries.delete(path);
    }
}

/**
 * Reads one manifest-owned icon through an ordinary-file handle and validates the exact bytes.
 *
 * The digest is the resource generation. A later read must produce the same digest before those
 * bytes can satisfy a generation-bound client request.
 */
export async function readPluginIcon(
    path: string,
    options: { signal?: AbortSignal } = {},
): Promise<PluginIconResource> {
    const opened = await openOrdinaryIcon(path);
    try {
        return await readAndValidate(opened.handle, opened.info, path, options.signal);
    } finally {
        await opened.handle.close();
    }
}

async function openOrdinaryIcon(path: string): Promise<{
    handle: FileHandle;
    info: BigIntStats;
}> {
    const pathInfo = await lstat(path, { bigint: true }).catch(() => undefined);
    if (pathInfo === undefined || !pathInfo.isFile() || pathInfo.isSymbolicLink()) {
        throw new Error("The plugin icon must be an ordinary file.");
    }
    let handle: FileHandle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        throw new Error("The plugin icon must be an ordinary file.");
    }
    try {
        const info = await handle.stat({ bigint: true });
        if (!info.isFile()) throw new Error("The plugin icon must be an ordinary file.");
        const currentPathInfo = await lstat(path, { bigint: true }).catch(() => undefined);
        if (
            currentPathInfo === undefined ||
            currentPathInfo.isSymbolicLink() ||
            pathInfo.dev !== info.dev ||
            pathInfo.ino !== info.ino ||
            currentPathInfo.dev !== info.dev ||
            currentPathInfo.ino !== info.ino
        ) {
            throw new Error("The plugin icon changed while Rig was reading it.");
        }
        return { handle, info };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function readAndValidate(
    handle: FileHandle,
    info: BigIntStats,
    path: string,
    signal?: AbortSignal,
): Promise<PluginIconResource> {
    signal?.throwIfAborted();
    if (info.size > BigInt(HAPPY_PLUGIN_MAX_ICON_BYTES)) throwIconTooLarge();
    const storage = Buffer.allocUnsafe(HAPPY_PLUGIN_MAX_ICON_BYTES + 1);
    let offset = 0;
    while (offset < storage.byteLength) {
        signal?.throwIfAborted();
        const result = await handle.read(storage, offset, storage.byteLength - offset, null);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
    }
    if (offset > HAPPY_PLUGIN_MAX_ICON_BYTES) throwIconTooLarge();
    if (BigInt(offset) !== info.size) {
        throw new Error("The plugin icon changed while Rig was reading it.");
    }
    const currentPathInfo = await lstat(path, { bigint: true }).catch(() => undefined);
    if (
        currentPathInfo === undefined ||
        currentPathInfo.isSymbolicLink() ||
        currentPathInfo.dev !== info.dev ||
        currentPathInfo.ino !== info.ino ||
        currentPathInfo.size !== info.size ||
        currentPathInfo.mtimeNs !== info.mtimeNs
    ) {
        throw new Error("The plugin icon changed while Rig was reading it.");
    }
    const body = storage.subarray(0, offset);
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
        metadata = await sharp(body, { failOn: "error", limitInputPixels: false }).metadata();
    } catch {
        throw new Error("The plugin icon is not a valid PNG image.");
    }
    if (metadata.format !== "png") throw new Error("The plugin icon is not a valid PNG image.");
    if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error("The plugin icon has no readable dimensions.");
    }
    if (metadata.width !== metadata.height) throw new Error("The plugin icon must be square.");
    if (metadata.width < 1 || metadata.width > HAPPY_PLUGIN_MAX_ICON_DIMENSION) {
        throw new Error(
            `The plugin icon dimensions must be between 1 and ${String(HAPPY_PLUGIN_MAX_ICON_DIMENSION)} pixels.`,
        );
    }
    signal?.throwIfAborted();
    try {
        await sharp(body, {
            failOn: "error",
            limitInputPixels: HAPPY_PLUGIN_MAX_ICON_DIMENSION ** 2,
        })
            .raw()
            .toBuffer();
    } catch {
        throw new Error("The plugin icon is not a valid PNG image.");
    }
    signal?.throwIfAborted();
    return {
        body,
        generation: createHash("sha256").update(body).digest("hex"),
        mediaType: "image/png",
        size: body.byteLength,
    };
}

function fileIdentity(info: BigIntStats): string {
    return `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`;
}

function summarize(resource: PluginIconResource): PluginIconSummary {
    return {
        generation: resource.generation,
        mediaType: resource.mediaType,
        size: resource.size,
    };
}

function throwIconTooLarge(): never {
    throw new Error(
        `The plugin icon cannot exceed ${String(HAPPY_PLUGIN_MAX_ICON_BYTES / MEBIBYTE)} MiB.`,
    );
}
