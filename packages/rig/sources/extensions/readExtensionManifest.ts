import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import {
    EXTENSION_MANIFEST_FILE_NAME,
    extensionManifestSchema,
    type RegisteredExtension,
} from "./types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export async function readExtensionManifest(directory: string): Promise<RegisteredExtension> {
    const manifestPath = resolve(directory, EXTENSION_MANIFEST_FILE_NAME);
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`${EXTENSION_MANIFEST_FILE_NAME} is not valid JSON.`);
        }
        throw error;
    }
    if (!Value.Check(extensionManifestSchema, parsed)) {
        const first = Value.Errors(extensionManifestSchema, parsed).First();
        const detail = first === undefined ? "" : ` ${first.path || "value"}: ${first.message}`;
        throw new Error(`${EXTENSION_MANIFEST_FILE_NAME} is invalid.${detail}`);
    }
    const manifest = parsed;

    const entryPath = resolveOwnedPath(directory, manifest.entry, "entry");
    const iconPath = resolveOwnedPath(directory, manifest.icon, "icon");
    const [entryInfo, iconInfo, iconHeader] = await Promise.all([
        lstat(entryPath),
        lstat(iconPath),
        readFile(iconPath).then((bytes) => bytes.subarray(0, PNG_SIGNATURE.length)),
    ]);
    if (!entryInfo.isFile()) throw new Error("The extension entry must be a file.");
    if (!iconInfo.isFile()) throw new Error("The extension icon must be a file.");
    if (!iconHeader.equals(PNG_SIGNATURE)) {
        throw new Error("The extension icon is not a valid PNG image.");
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
    if (isAbsolute(value)) throw new Error(`The extension ${field} must be a relative path.`);
    const root = resolve(directory);
    const path = resolve(root, value);
    const fromRoot = relative(root, path);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new Error(`The extension ${field} must stay inside its folder.`);
    }
    return path;
}
