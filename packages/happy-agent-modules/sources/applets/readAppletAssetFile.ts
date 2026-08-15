import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { AppletAsset } from "./Applet.js";

/** Only files with a known static-web extension are served; everything else is not found. */
const CONTENT_TYPES: Readonly<Record<string, { contentType: string; text: boolean }>> = {
    avif: { contentType: "image/avif", text: false },
    css: { contentType: "text/css; charset=utf-8", text: true },
    gif: { contentType: "image/gif", text: false },
    htm: { contentType: "text/html; charset=utf-8", text: true },
    html: { contentType: "text/html; charset=utf-8", text: true },
    ico: { contentType: "image/x-icon", text: false },
    jpeg: { contentType: "image/jpeg", text: false },
    jpg: { contentType: "image/jpeg", text: false },
    js: { contentType: "text/javascript; charset=utf-8", text: true },
    json: { contentType: "application/json; charset=utf-8", text: true },
    map: { contentType: "application/json; charset=utf-8", text: true },
    md: { contentType: "text/markdown; charset=utf-8", text: true },
    mjs: { contentType: "text/javascript; charset=utf-8", text: true },
    mp3: { contentType: "audio/mpeg", text: false },
    mp4: { contentType: "video/mp4", text: false },
    otf: { contentType: "font/otf", text: false },
    png: { contentType: "image/png", text: false },
    svg: { contentType: "image/svg+xml", text: true },
    ttf: { contentType: "font/ttf", text: false },
    txt: { contentType: "text/plain; charset=utf-8", text: true },
    wasm: { contentType: "application/wasm", text: false },
    webm: { contentType: "video/webm", text: false },
    webp: { contentType: "image/webp", text: false },
    woff: { contentType: "font/woff", text: false },
    woff2: { contentType: "font/woff2", text: false },
};

/**
 * Reads one static asset from an applet's version folder.
 *
 * Only that version's own files are reachable: traversal (`..`), backslashes,
 * NUL bytes, and dotfiles are refused with a thrown error, a resolved symlink
 * may not leave the version folder, unknown extensions are reported as missing
 * rather than sniffed, and a file above the byte cap is refused. Text-like
 * files are returned as UTF-8; binary files are returned as base64.
 */
export async function readAppletAssetFile(
    rootDirectory: string,
    name: string,
    version: number,
    assetPath: string,
    maxBytes: number,
): Promise<AppletAsset | undefined> {
    const segments = assetPath === "" ? ["index.html"] : assetPath.split("/");
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new Error("The applet asset path is not allowed.");
        }
        if (segment.startsWith(".") || segment.includes("\\") || segment.includes("\0")) {
            throw new Error("The applet asset path is not allowed.");
        }
    }
    const extension = segments.at(-1)?.split(".").at(-1)?.toLowerCase();
    const media = extension === undefined ? undefined : CONTENT_TYPES[extension];
    if (media === undefined) return undefined;

    const root = resolve(rootDirectory, name, `v${String(version)}`);
    const target = join(root, ...segments);
    let realTarget: string;
    let realRoot: string;
    try {
        realTarget = await realpath(target);
        realRoot = await realpath(root);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw error;
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
        throw new Error("The applet asset path is not allowed.");
    }
    const facts = await stat(realTarget);
    if (!facts.isFile()) return undefined;
    if (facts.size > maxBytes) {
        throw new Error("Applet asset exceeds the configured byte limit.");
    }
    const data = await readFile(realTarget);
    if (data.byteLength > maxBytes) {
        throw new Error("Applet asset exceeds the configured byte limit.");
    }
    const encoding = media.text ? "utf8" : "base64";
    return {
        name,
        version,
        path: assetPath,
        contentType: media.contentType,
        encoding,
        content: media.text ? data.toString("utf8") : data.toString("base64"),
        byteLength: data.byteLength,
    };
}
