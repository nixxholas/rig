import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { getWebappsDirectory } from "./getWebappsDirectory.js";
import { isValidWebappName } from "./isValidWebappName.js";

/** Only files with a known static-web extension are served; everything else is not found. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
    avif: "image/avif",
    css: "text/css; charset=utf-8",
    gif: "image/gif",
    htm: "text/html; charset=utf-8",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    otf: "font/otf",
    png: "image/png",
    svg: "image/svg+xml",
    ttf: "font/ttf",
    txt: "text/plain; charset=utf-8",
    wasm: "application/wasm",
    webm: "video/webm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
};

export const WEBAPP_FILE_MAX_BYTES = 10 * 1024 * 1024;

export type WebappFileResult =
    | { type: "file"; contentType: string; data: Buffer }
    | { type: "invalid_path" }
    | { type: "not_found" };

/**
 * Reads one static file from a webapp's version folder for serving over HTTP.
 *
 * Only that version's own files are reachable: traversal (`..`), backslashes, NUL bytes, and
 * dotfiles are rejected, a resolved symlink may not leave the version folder, unknown extensions
 * are not found rather than sniffed, and a file above the size cap is refused.
 */
export async function readWebappFile(
    name: string,
    version: number,
    filePath: string,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<WebappFileResult> {
    if (!isValidWebappName(name)) return { type: "invalid_path" };
    if (!Number.isSafeInteger(version) || version < 1) return { type: "invalid_path" };
    const segments = filePath === "" ? ["index.html"] : filePath.split("/");
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") return { type: "invalid_path" };
        if (segment.startsWith(".")) return { type: "invalid_path" };
        if (segment.includes("\\") || segment.includes("\0")) return { type: "invalid_path" };
    }
    const extension = segments.at(-1)?.split(".").at(-1)?.toLowerCase();
    const contentType = extension === undefined ? undefined : CONTENT_TYPES[extension];
    if (contentType === undefined) return { type: "not_found" };
    const root = resolve(getWebappsDirectory(environment), name, `v${String(version)}`);
    const target = join(root, ...segments);
    try {
        const realTarget = await realpath(target);
        const realRoot = await realpath(root);
        if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
            return { type: "invalid_path" };
        }
        const facts = await stat(realTarget);
        if (!facts.isFile() || facts.size > WEBAPP_FILE_MAX_BYTES) return { type: "not_found" };
        return { contentType, data: await readFile(realTarget), type: "file" };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { type: "not_found" };
        throw error;
    }
}
