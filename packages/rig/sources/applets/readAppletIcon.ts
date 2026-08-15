import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { getAppletsDirectory } from "./getAppletsDirectory.js";
import { isValidAppletName } from "./isValidAppletName.js";

const ICON_FILE_NAMES = {
    ico: "favicon.ico",
    png: "favicon.png",
} as const;

export type AppletIconFormat = keyof typeof ICON_FILE_NAMES;

export type AppletIconFileResult =
    | { contentType: string; data: Buffer; type: "file" }
    | { type: "invalid_name" }
    | { type: "not_found" };

/** Reads one fixed, Rig-generated identity icon without exposing arbitrary applet-root paths. */
export async function readAppletIcon(
    name: string,
    format: AppletIconFormat,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<AppletIconFileResult> {
    if (!isValidAppletName(name)) return { type: "invalid_name" };
    const root = join(getAppletsDirectory(environment), name);
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

export function appletIconUrl(name: string): string {
    return `/applets/${encodeURIComponent(name)}/favicon.png`;
}
