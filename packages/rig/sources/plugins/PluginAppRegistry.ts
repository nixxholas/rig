import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import type {
    HappyMcpToolResult,
    HappyPluginAppContribution,
    HappyPluginResourceMediaType,
} from "happy-plugins";
import {
    assertHappyPluginStorageKey,
    assertHappyPluginStorageQuota,
    decodeHappyPluginStorageValue,
    encodeHappyPluginStorageValue,
    HAPPY_PLUGIN_MAX_STORAGE_KEYS,
    happyPluginAppContributionSchema,
} from "happy-plugins";

import type { PluginAppSnapshot, PluginRuntimeSnapshot } from "./types.js";
import {
    PluginMcpCallTimeoutError,
    PluginMcpNotRunningError,
    PluginMcpRegistry,
    PluginMcpStaleGenerationError,
    PluginMcpToolNotFoundError,
} from "./PluginMcpRegistry.js";

const MCP_APP_HTML = "text/html;profile=mcp-app";

export type PluginAppErrorCode =
    | "invalid_input"
    | "plugin_not_running"
    | "stale_generation"
    | "storage_full"
    | "timeout"
    | "tool_not_found";

export class PluginAppError extends Error {
    // A plain field rather than a constructor parameter property: the gym runs this source through
    // Node's strip-only TypeScript support, which refuses to parse parameter properties.
    readonly code: PluginAppErrorCode;

    constructor(code: PluginAppErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "PluginAppError";
    }
}

export interface PluginAppResource {
    blob?: string;
    mimeType: string;
    text?: string;
    uri: string;
}

interface RegisteredApp {
    app: PluginAppSnapshot;
    dataDirectory: string;
    folder: string;
    generation: string;
    pluginName: string;
}

/**
 * Immutable manifest-declared MCP Apps and their host-mediated backend.
 *
 * The bytes are snapshotted before the plugin process starts. Runtime identity is still tied to
 * the process generation, so a renderer can never call replacement tools or storage by accident.
 */
export class PluginAppRegistry {
    readonly #apps = new Map<string, RegisteredApp>();
    readonly #storageQueues = new Map<string, Promise<void>>();
    readonly mcp: PluginMcpRegistry;

    constructor(mcp: PluginMcpRegistry) {
        this.mcp = mcp;
    }

    register(plugin: PluginRuntimeSnapshot, generation: string, dataDirectory: string): () => void {
        const owned: string[] = [];
        for (const app of plugin.apps) {
            const id = appIdentity(plugin.folderName, app.id);
            if (this.#apps.has(id))
                throw new Error(`Plugin app "${app.id}" is already registered.`);
            this.#apps.set(id, {
                app,
                dataDirectory,
                folder: plugin.folderName,
                generation,
                pluginName: plugin.manifest.name,
            });
            owned.push(id);
        }
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            for (const id of owned) {
                const current = this.#apps.get(id);
                if (current?.generation === generation) this.#apps.delete(id);
            }
        };
    }

    list(folder?: string): readonly HappyPluginAppContribution[] {
        return [...this.#apps.values()]
            .filter((entry) => folder === undefined || entry.folder === folder)
            .map((entry) =>
                toContribution(entry, this.mcp.listAppTools(entry.folder, entry.generation)),
            )
            .sort(compareApps);
    }

    readResource(id: string, generation: string, uri: string): PluginAppResource {
        const entry = this.#find(id, generation);
        const resource = entry.app.resources.find(
            (candidate) => resourceUri(entry, candidate.path) === uri,
        );
        if (resource === undefined) {
            throw new PluginAppError("invalid_input", "That MCP App resource is not declared.");
        }
        const mimeType = resource.path === entry.app.page ? MCP_APP_HTML : resource.mediaType;
        return textResource(resource.mediaType)
            ? { mimeType, text: resource.body.toString("utf8"), uri }
            : { blob: resource.body.toString("base64"), mimeType, uri };
    }

    async callTool(
        id: string,
        generation: string,
        server: string,
        tool: string,
        input: unknown,
        signal?: AbortSignal,
    ): Promise<HappyMcpToolResult> {
        const entry = this.#find(id, generation);
        try {
            return await this.mcp.callAppTool(
                entry.folder,
                generation,
                server,
                tool,
                input,
                signal,
            );
        } catch (error) {
            if (error instanceof PluginMcpNotRunningError) {
                throw new PluginAppError("plugin_not_running", error.message);
            }
            if (error instanceof PluginMcpStaleGenerationError) {
                throw new PluginAppError("stale_generation", error.message);
            }
            if (error instanceof PluginMcpToolNotFoundError) {
                throw new PluginAppError("tool_not_found", error.message);
            }
            if (error instanceof PluginMcpCallTimeoutError) {
                throw new PluginAppError("timeout", error.message);
            }
            throw error;
        }
    }

    async storageGet(id: string, generation: string, key: string): Promise<unknown | undefined> {
        const entry = this.#find(id, generation);
        assertStorageKey(key);
        await cleanupStorageTemps(storageDirectory(entry));
        try {
            return decodeHappyPluginStorageValue(await readFile(storagePath(entry, key), "utf8"));
        } catch (error) {
            if (isFileSystemError(error, "ENOENT")) return undefined;
            if (error instanceof SyntaxError) {
                throw new PluginAppError("invalid_input", "The stored value is not valid JSON.");
            }
            throw error;
        }
    }

    async storageList(id: string, generation: string): Promise<readonly string[]> {
        const entry = this.#find(id, generation);
        const directory = storageDirectory(entry);
        await cleanupStorageTemps(directory);
        try {
            const keys = (await readdir(directory, { withFileTypes: true }))
                .filter((item) => item.isFile() && item.name.endsWith(".json"))
                .map((item) => item.name.slice(0, -5))
                .sort();
            if (keys.length > HAPPY_PLUGIN_MAX_STORAGE_KEYS) {
                throw new PluginAppError("storage_full", "The plugin has too many storage keys.");
            }
            return keys;
        } catch (error) {
            if (isFileSystemError(error, "ENOENT")) return [];
            throw error;
        }
    }

    async storageSet(id: string, generation: string, key: string, value: unknown): Promise<void> {
        const entry = this.#find(id, generation);
        assertStorageKey(key);
        let body: string;
        try {
            body = encodeHappyPluginStorageValue(value);
        } catch (error) {
            throw new PluginAppError(
                "invalid_input",
                error instanceof Error ? error.message : String(error),
            );
        }
        const bytes = Buffer.byteLength(body);
        await this.#serialize(entry.folder, async () => {
            const directory = storageDirectory(entry);
            await mkdir(directory, { recursive: true });
            await cleanupStorageTemps(directory);
            const keys = await storageKeys(directory);
            if (!keys.includes(key) && keys.length >= HAPPY_PLUGIN_MAX_STORAGE_KEYS) {
                throw new PluginAppError("storage_full", "The plugin has too many storage keys.");
            }
            const existing = await storageSize(directory);
            try {
                assertHappyPluginStorageQuota(
                    existing - (await existingSize(storagePath(entry, key))) + bytes,
                );
            } catch {
                throw new PluginAppError("storage_full", "The plugin storage quota is full.");
            }
            const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
            try {
                await writeFile(temporary, body, { flag: "wx" });
                await rename(temporary, storagePath(entry, key));
            } finally {
                await rm(temporary, { force: true });
            }
        });
    }

    async storageDelete(id: string, generation: string, key: string): Promise<void> {
        const entry = this.#find(id, generation);
        assertStorageKey(key);
        await this.#serialize(entry.folder, async () => {
            await cleanupStorageTemps(storageDirectory(entry));
            await rm(storagePath(entry, key), { force: true });
        });
    }

    #find(id: string, generation: string): RegisteredApp {
        const entry = this.#apps.get(id);
        if (entry === undefined) {
            throw new PluginAppError("plugin_not_running", "That plugin app is not running.");
        }
        if (entry.generation !== generation) {
            throw new PluginAppError("stale_generation", "That plugin app generation is stale.");
        }
        return entry;
    }

    #serialize(folder: string, operation: () => Promise<void>): Promise<void> {
        const before = this.#storageQueues.get(folder) ?? Promise.resolve();
        const current = before.catch(() => undefined).then(operation);
        this.#storageQueues.set(folder, current);
        return current.finally(() => {
            if (this.#storageQueues.get(folder) === current) this.#storageQueues.delete(folder);
        });
    }

}

function toContribution(
    entry: RegisteredApp,
    tools: ReturnType<PluginMcpRegistry["listAppTools"]>,
): HappyPluginAppContribution {
    return Value.Decode(happyPluginAppContributionSchema, {
        appId: entry.app.id,
        generation: entry.generation,
        id: appIdentity(entry.folder, entry.app.id),
        page: entry.app.page,
        pluginFolder: entry.folder,
        resources: entry.app.resources.map((resource) => ({
            mimeType: resource.path === entry.app.page ? MCP_APP_HTML : resource.mediaType,
            path: resource.path,
            size: resource.body.byteLength,
            uri: resourceUri(entry, resource.path),
        })),
        resourceUri: entry.app.resourceUri,
        sidebar: entry.app.sidebar,
        title: entry.app.title,
        tools: tools.map((tool) => ({
            ...tool,
            _meta: {
                ui: {
                    resourceUri: entry.app.resourceUri,
                    visibility: [...tool._meta.ui.visibility],
                },
            },
        })),
    });
}

function resourceUri(entry: RegisteredApp, path: string): string {
    const prefix = entry.app.resourceUri.slice(
        0,
        entry.app.resourceUri.length - entry.app.page.length,
    );
    return `${prefix}${path}`;
}

function appIdentity(folder: string, app: string): string {
    return `${folder}:${app}`;
}

function compareApps(left: HappyPluginAppContribution, right: HappyPluginAppContribution): number {
    return (
        left.sidebar.order - right.sidebar.order ||
        left.sidebar.label.localeCompare(right.sidebar.label) ||
        left.id.localeCompare(right.id)
    );
}

function textResource(mediaType: HappyPluginResourceMediaType): boolean {
    return mediaType.startsWith("text/") || mediaType === "application/json";
}

function assertStorageKey(key: string): void {
    try {
        assertHappyPluginStorageKey(key);
    } catch (error) {
        throw new PluginAppError(
            "invalid_input",
            error instanceof Error ? error.message : String(error),
        );
    }
}

function storageDirectory(entry: RegisteredApp): string {
    return join(entry.dataDirectory, "storage");
}

function storagePath(entry: RegisteredApp, key: string): string {
    return join(storageDirectory(entry), `${key}.json`);
}

async function existingSize(path: string): Promise<number> {
    return stat(path).then(
        (info) => info.size,
        (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? 0 : Promise.reject(error)),
    );
}

async function storageSize(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
            continue;
        }
        total += (await stat(join(directory, entry.name))).size;
    }
    return total;
}

async function storageKeys(directory: string): Promise<string[]> {
    return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5));
}

async function cleanupStorageTemps(directory: string): Promise<void> {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return;
        throw error;
    }
    await Promise.all(
        entries
            .filter(
                (entry) =>
                    entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp"),
            )
            .map((entry) => rm(join(directory, entry.name), { force: true })),
    );
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}
