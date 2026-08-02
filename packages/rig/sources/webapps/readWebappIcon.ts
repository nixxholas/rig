import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { getWebappsDirectory } from "./getWebappsDirectory.js";
import { isValidWebappName } from "./isValidWebappName.js";

const ICON_FILE_NAMES = {
    ico: "favicon.ico",
    png: "favicon.png",
} as const;

export type WebappIconFormat = keyof typeof ICON_FILE_NAMES;

export type WebappIconFileResult =
    | { contentType: string; data: Buffer; type: "file" }
    | { type: "invalid_name" }
    | { type: "not_found" };

/** Reads one fixed, Rig-generated identity icon without exposing arbitrary webapp-root paths. */
export async function readWebappIcon(
    name: string,
    format: WebappIconFormat,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<WebappIconFileResult> {
    if (!isValidWebappName(name)) return { type: "invalid_name" };
    const root = join(getWebappsDirectory(environment), name);
    const target = join(root, ICON_FILE_NAMES[format]);
    try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        if (!realTarget.startsWith(realRoot + sep)) return { type: "not_found" };
        const facts = await stat(realTarget);
        if (!facts.isFile() || facts.size > 8 * 1024 * 1024) return { type: "not_found" };
        return {
            contentType: format === "png" ? "image/png" : "image/x-icon",
            data: await readFile(realTarget),
            type: "file",
        };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { type: "not_found" };
        throw error;
    }
}

export function webappIconUrl(name: string): string {
    return `/webapps/${encodeURIComponent(name)}/favicon.png`;
}
