import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES } from "happy-plugins";

import {
    fileSystemErrorSchema,
    PLUGIN_MANIFEST_FILE_NAME,
    pluginManifestSchema,
    type RegisteredPlugin,
} from "./types.js";
import { resolvePluginDockerRuntime } from "./resolvePluginDockerRuntime.js";
import { PluginIconSummaryCache, readPluginIcon } from "./readPluginIcon.js";

const CONVENTIONAL_SKILLS_DIRECTORY = "skills";

export async function readPluginManifest(
    directory: string,
    options: { folderName?: string; iconCache?: PluginIconSummaryCache } = {},
): Promise<RegisteredPlugin> {
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

    const entryPath =
        manifest.main === undefined
            ? undefined
            : resolveOwnedPath(directory, manifest.main, "main entry point");
    const folderName = options.folderName ?? directory.split(/[\\/]/u).at(-1) ?? directory;
    const iconPath = resolveOwnedPath(directory, manifest.icon, "icon");
    if (manifest.compute !== undefined && entryPath === undefined) {
        throw new Error("A plugin that provides compute must declare a main entry point.");
    }
    const [docker, skillsPath, systemPrompt] = await Promise.all([
        resolvePluginDockerRuntime({
            declaration: manifest.docker,
            directory,
            hasMain: entryPath !== undefined,
        }),
        resolveSkillsPath(directory, manifest.skills),
        resolveSystemPrompt(directory, manifest.systemPrompt),
    ]);
    if (entryPath === undefined && skillsPath === undefined && systemPrompt === undefined) {
        throw new Error(
            "The plugin must declare a main entry point, provide a skills directory, or contribute a system prompt.",
        );
    }
    const entryInfo =
        entryPath === undefined
            ? undefined
            : await lstat(entryPath).catch((error: unknown) => {
                  if (Value.Check(fileSystemErrorSchema, error) && error.code === "ENOENT") {
                      throw new Error(
                          `The plugin main entry point ${JSON.stringify(manifest.main)} does not exist.`,
                      );
                  }
                  throw error;
              });
    if (entryInfo !== undefined && (!entryInfo.isFile() || entryInfo.isSymbolicLink())) {
        throw new Error("The plugin main entry point must be a file.");
    }
    const iconInfo = await lstat(iconPath).catch(() => undefined);
    if (iconInfo === undefined || !iconInfo.isFile() || iconInfo.isSymbolicLink()) {
        throw new Error("The plugin icon must be an ordinary file.");
    }
    await Promise.all([
        entryPath === undefined
            ? undefined
            : assertOwnedRealPath(directory, entryPath, "main entry point"),
        assertOwnedRealPath(directory, iconPath, "icon"),
    ]);
    const icon = await (options.iconCache?.read(iconPath) ?? readPluginIcon(iconPath));

    return {
        directory: resolve(directory),
        ...(docker === undefined ? {} : { docker }),
        ...(entryPath === undefined ? {} : { entryPath }),
        folderName,
        icon: {
            generation: icon.generation,
            mediaType: icon.mediaType,
            size: icon.size,
        },
        iconPath,
        manifest,
        manifestPath,
        ...(skillsPath === undefined ? {} : { skillsPath }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
    };
}

async function resolveSystemPrompt(
    directory: string,
    contribution: RegisteredPlugin["manifest"]["systemPrompt"],
): Promise<string | undefined> {
    if (contribution === undefined) return undefined;
    if ("text" in contribution) {
        if (Buffer.byteLength(contribution.text, "utf8") > HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES) {
            throw new Error(
                `The plugin system prompt cannot exceed ${String(HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES)} UTF-8 bytes.`,
            );
        }
        return contribution.text;
    }
    const path = resolveOwnedPath(directory, contribution.path, "system prompt");
    let info;
    try {
        info = await lstat(path);
    } catch (error) {
        if (Value.Check(fileSystemErrorSchema, error) && error.code === "ENOENT") {
            throw new Error("The plugin system prompt file does not exist.");
        }
        throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("The plugin system prompt path must be an ordinary file.");
    }
    if (info.size > HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES) {
        throw new Error(
            `The plugin system prompt cannot exceed ${String(HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES)} UTF-8 bytes.`,
        );
    }
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES) {
        throw new Error(
            `The plugin system prompt cannot exceed ${String(HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES)} UTF-8 bytes.`,
        );
    }
    return text;
}

async function resolveSkillsPath(
    directory: string,
    declaredPath: string | undefined,
): Promise<string | undefined> {
    const path = resolveOwnedPath(
        directory,
        declaredPath ?? CONVENTIONAL_SKILLS_DIRECTORY,
        "skills directory",
    );
    let info;
    try {
        info = await lstat(path);
    } catch (error) {
        if (Value.Check(fileSystemErrorSchema, error) && error.code === "ENOENT") {
            if (declaredPath === undefined) return undefined;
            throw new Error("The plugin skills directory does not exist.");
        }
        throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
        if (declaredPath === undefined) return undefined;
        throw new Error("The plugin skills path must be an ordinary directory.");
    }
    return path;
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

async function assertOwnedRealPath(directory: string, path: string, field: string): Promise<void> {
    let root: string;
    let target: string;
    try {
        [root, target] = await Promise.all([realpath(directory), realpath(path)]);
    } catch (error) {
        if (
            field === "icon" &&
            Value.Check(fileSystemErrorSchema, error) &&
            error.code === "ENOENT"
        ) {
            throw new Error("The plugin icon must be an ordinary file.");
        }
        throw error;
    }
    const fromRoot = relative(root, target);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new Error(`The plugin ${field} must stay inside its folder.`);
    }
}
