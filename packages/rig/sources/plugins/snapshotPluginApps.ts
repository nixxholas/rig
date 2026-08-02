import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
    HAPPY_PLUGIN_MAX_APP_BYTES,
    HAPPY_PLUGIN_MAX_APP_RESOURCES,
    HAPPY_PLUGIN_MAX_RESOURCE_BYTES,
    happyPluginAppResourceMediaType,
    happyPluginResourcePathSchema,
    isHappyPluginImageMediaType,
} from "happy-plugins";
import { Value } from "@sinclair/typebox/value";

import type {
    PluginAppManifest,
    PluginAppResourceSnapshot,
    PluginAppSnapshot,
    RegisteredPlugin,
} from "./types.js";

/** Reads and validates the immutable UI snapshot for one plugin process generation. */
export async function snapshotPluginApps(
    plugin: RegisteredPlugin,
): Promise<readonly PluginAppSnapshot[]> {
    const apps = plugin.manifest.apps ?? [];
    const ids = new Set<string>();
    for (const app of apps) {
        if (ids.has(app.id)) throw new Error(`More than one plugin app is named "${app.id}".`);
        ids.add(app.id);
    }
    const snapshots: PluginAppSnapshot[] = [];
    for (const app of apps) {
        snapshots.push(await snapshotApp(plugin, app));
    }
    return snapshots;
}

async function snapshotApp(
    plugin: RegisteredPlugin,
    app: PluginAppManifest,
): Promise<PluginAppSnapshot> {
    const root = resolveInside(plugin.directory, app.root, `app "${app.id}" root`);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error(`The root for plugin app "${app.id}" must be an ordinary directory.`);
    }
    const state = { bytes: 0, resources: [] as PluginAppResourceSnapshot[] };
    await visit(root, root, state, app.id);
    const { resources } = state;
    resources.sort((left, right) => left.path.localeCompare(right.path));
    if (resources.length === 0) throw new Error(`Plugin app "${app.id}" has no resources.`);
    const page = resources.find((resource) => resource.path === app.page);
    if (page?.mediaType !== "text/html") {
        throw new Error(`Plugin app "${app.id}" page must name an HTML file inside its root.`);
    }
    if (app.sidebar.icon !== undefined) {
        const icon = resources.find((resource) => resource.path === app.sidebar.icon);
        if (icon === undefined) {
            throw new Error(`Plugin app "${app.id}" sidebar icon does not exist inside its root.`);
        }
        if (!isHappyPluginImageMediaType(icon.mediaType)) {
            throw new Error(`Plugin app "${app.id}" sidebar icon must be an image.`);
        }
    }
    const pluginAuthority = encodeURIComponent(plugin.folderName);
    const resourceUri = `ui://${pluginAuthority}/${encodeURIComponent(app.id)}/${encodeResourcePath(app.page)}`;
    assertResourceUri(resourceUri);
    return {
        id: app.id,
        page: app.page,
        resources,
        resourceUri,
        sidebar: app.sidebar,
        title: app.title,
    };
}

async function visit(
    root: string,
    directory: string,
    state: { bytes: number; resources: PluginAppResourceSnapshot[] },
    appId: string,
): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
            throw new Error(`Plugin app "${appId}" cannot contain symbolic links.`);
        }
        if (info.isDirectory()) {
            await visit(root, path, state, appId);
            continue;
        }
        if (!info.isFile()) throw new Error(`Plugin app "${appId}" contains a non-file entry.`);
        if (state.resources.length >= HAPPY_PLUGIN_MAX_APP_RESOURCES) {
            throw new Error(
                `Plugin app "${appId}" has more than ${String(HAPPY_PLUGIN_MAX_APP_RESOURCES)} resources.`,
            );
        }
        if (info.size > HAPPY_PLUGIN_MAX_RESOURCE_BYTES) {
            throw new Error(
                `Plugin app "${appId}" resource "${relative(root, path)}" is larger than ${String(HAPPY_PLUGIN_MAX_RESOURCE_BYTES)} bytes.`,
            );
        }
        if (state.bytes + info.size > HAPPY_PLUGIN_MAX_APP_BYTES) {
            throw new Error(
                `Plugin app "${appId}" is larger than ${String(HAPPY_PLUGIN_MAX_APP_BYTES)} bytes.`,
            );
        }
        const resourcePath = relative(root, path).split("\\").join("/");
        let decodedPath: string;
        try {
            decodedPath = Value.Decode(happyPluginResourcePathSchema, resourcePath);
        } catch {
            throw new Error(
                `Plugin app "${appId}" resource path "${resourcePath}" is not URI-safe.`,
            );
        }
        if (state.resources.some((resource) => resource.path === decodedPath)) {
            throw new Error(
                `Plugin app "${appId}" contains duplicate resource path "${decodedPath}".`,
            );
        }
        const mediaType = happyPluginAppResourceMediaType(decodedPath);
        if (mediaType === undefined) {
            throw new Error(
                `Plugin app "${appId}" resource "${relative(root, path)}" has an unsupported file type.`,
            );
        }
        state.bytes += info.size;
        state.resources.push({
            body: await readFile(path),
            mediaType,
            path: decodedPath,
        });
    }
}

function encodeResourcePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

function assertResourceUri(value: string): void {
    const parsed = new URL(value);
    if (parsed.protocol !== "ui:" || parsed.hostname.length === 0 || parsed.hash.length > 0) {
        throw new Error(`The plugin app resource URI ${JSON.stringify(value)} is invalid.`);
    }
}

function resolveInside(directory: string, value: string, field: string): string {
    const root = resolve(directory);
    const path = resolve(root, value);
    const fromRoot = relative(root, path);
    if (fromRoot === "" || fromRoot.startsWith("..") || fromRoot.startsWith("/")) {
        throw new Error(`The plugin ${field} must stay inside its folder.`);
    }
    return path;
}
