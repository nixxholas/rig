import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { PLUGIN_MANIFEST_FILE_NAME, pluginManifestSchema, type RegisteredPlugin } from "./types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export async function readPluginManifest(directory: string): Promise<RegisteredPlugin> {
    const manifestPath = resolve(directory, PLUGIN_MANIFEST_FILE_NAME);
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`${PLUGIN_MANIFEST_FILE_NAME} is not valid JSON.`);
        }
        throw error;
    }
    const normalized = Value.Default(pluginManifestSchema, parsed);
    if (!Value.Check(pluginManifestSchema, normalized)) {
        const first = Value.Errors(pluginManifestSchema, normalized).First();
        if (first?.path === "/version") {
            throw new Error(
                `${PLUGIN_MANIFEST_FILE_NAME} is invalid. /version: Expected a semantic version such as 1.2.3.`,
            );
        }
        const detail = first === undefined ? "" : ` ${first.path || "value"}: ${first.message}`;
        throw new Error(`${PLUGIN_MANIFEST_FILE_NAME} is invalid.${detail}`);
    }
    const manifest = {
        ...normalized,
        version: normalized.version!,
    };

    const entryPath = resolveOwnedPath(directory, manifest.entry, "entry");
    const iconPath = resolveOwnedPath(directory, manifest.icon, "icon");
    const [entryInfo, iconInfo, iconHeader] = await Promise.all([
        lstat(entryPath),
        lstat(iconPath),
        readFile(iconPath).then((bytes) => bytes.subarray(0, PNG_SIGNATURE.length)),
    ]);
    if (!entryInfo.isFile()) throw new Error("The plugin entry must be a file.");
    if (!iconInfo.isFile()) throw new Error("The plugin icon must be a file.");
    if (!iconHeader.equals(PNG_SIGNATURE)) {
        throw new Error("The plugin icon is not a valid PNG image.");
    }

    return {
        directory: resolve(directory),
        entryPath,
        folderName: directory.split(/[\\/]/u).at(-1) ?? directory,
        iconPath,
        manifest,
        manifestPath,
    };
}

function resolveOwnedPath(directory: string, value: string, field: string): string {
    if (isAbsolute(value)) throw new Error(`The plugin ${field} must be a relative path.`);
    const root = resolve(directory);
    const path = resolve(root, value);
    const fromRoot = relative(root, path);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new Error(`The plugin ${field} must stay inside its folder.`);
    }
    return path;
}
