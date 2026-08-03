import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { HAPPY_PLUGIN_MAX_ICON_BYTES, HAPPY_PLUGIN_MAX_ICON_DIMENSION } from "happy-plugins";
import sharp from "sharp";

import type { PluginIconResource } from "./types.js";

const MEBIBYTE = 1024 * 1024;

/**
 * Reads one manifest-owned icon through an ordinary-file handle and validates the exact bytes.
 *
 * The digest is the resource generation. A later read must produce the same digest before those
 * bytes can satisfy a generation-bound client request.
 */
export async function readPluginIcon(path: string): Promise<PluginIconResource> {
    const pathInfo = await lstat(path).catch(() => undefined);
    if (pathInfo === undefined || !pathInfo.isFile() || pathInfo.isSymbolicLink()) {
        throw new Error("The plugin icon must be an ordinary file.");
    }
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        throw new Error("The plugin icon must be an ordinary file.");
    }
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("The plugin icon must be an ordinary file.");
        const currentPathInfo = await lstat(path).catch(() => undefined);
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
        if (info.size > HAPPY_PLUGIN_MAX_ICON_BYTES) {
            throw new Error(
                `The plugin icon cannot exceed ${String(HAPPY_PLUGIN_MAX_ICON_BYTES / MEBIBYTE)} MiB.`,
            );
        }
        const body = await handle.readFile();
        if (body.byteLength !== info.size || body.byteLength > HAPPY_PLUGIN_MAX_ICON_BYTES) {
            throw new Error("The plugin icon changed while Rig was reading it.");
        }

        let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
        try {
            metadata = await sharp(body, {
                failOn: "error",
                limitInputPixels: HAPPY_PLUGIN_MAX_ICON_DIMENSION ** 2,
            }).metadata();
        } catch {
            throw new Error("The plugin icon is not a valid PNG image.");
        }
        if (metadata.format !== "png") {
            throw new Error("The plugin icon is not a valid PNG image.");
        }
        if (metadata.width === undefined || metadata.height === undefined) {
            throw new Error("The plugin icon has no readable dimensions.");
        }
        if (metadata.width !== metadata.height) {
            throw new Error("The plugin icon must be square.");
        }
        if (metadata.width < 1 || metadata.width > HAPPY_PLUGIN_MAX_ICON_DIMENSION) {
            throw new Error(
                `The plugin icon dimensions must be between 1 and ${String(HAPPY_PLUGIN_MAX_ICON_DIMENSION)} pixels.`,
            );
        }
        return {
            body,
            generation: createHash("sha256").update(body).digest("hex"),
            mediaType: "image/png",
            size: body.byteLength,
        };
    } finally {
        await handle.close();
    }
}
