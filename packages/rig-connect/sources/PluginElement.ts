import { Value } from "@sinclair/typebox/value";

import type { ConnectionState } from "./ChatElement.js";
import {
    pluginAppContributionSchema,
    type PluginAppContribution,
    type PluginSummary,
} from "./protocol.js";

export interface PluginAppResource {
    mimeType: string;
    path: string;
    size: number;
    uri: string;
}

/**
 * One stable local application identity.
 *
 * `generation` changes when plugin code is replaced or restarted. Hosts must include the
 * generation they rendered in resource and action calls so stale views fail closed.
 */
export interface PluginApp {
    appId: string;
    generation: string;
    id: string;
    page: string;
    pluginId: string;
    resourceUri: string;
    resources: readonly PluginAppResource[];
    sidebar: {
        icon?: string;
        label: string;
        order: number;
    };
    title: string;
    tools: PluginAppContribution["tools"];
}

export interface LocalPlugin {
    apps: readonly PluginApp[];
    dataDirectory: string;
    description: string;
    directory: string;
    error?: string;
    id: string;
    logAvailable: boolean;
    name: string;
    status: "build_failed" | "running" | "stopped";
}

export interface PluginCatalogFailure {
    error: string;
    pluginId: string;
}

export class PluginAppRequestError extends Error {
    constructor(
        readonly code: string,
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "PluginAppRequestError";
    }
}

export interface PluginsState {
    connection: ConnectionState;
    failures: readonly PluginCatalogFailure[];
}

export interface ReadPluginAppResourceResult {
    contents: readonly {
        blob?: string;
        mimeType: string;
        text?: string;
        uri: string;
    }[];
}

/** Immutable, reference-stable projection of the daemon's plugin catalog. */
export class PluginStore {
    #apps: readonly PluginApp[] = [];
    #plugins: readonly LocalPlugin[] = [];
    #state: PluginsState = { connection: "connecting", failures: [] };

    apps(): readonly PluginApp[] {
        return this.#apps;
    }

    plugins(): readonly LocalPlugin[] {
        return this.#plugins;
    }

    state(): PluginsState {
        return this.#state;
    }

    replace(
        plugins: readonly PluginSummary[],
        failures: readonly { error: string; folder: string }[],
        connection: ConnectionState,
    ): boolean {
        const previous = new Map(this.#plugins.map((plugin) => [plugin.id, plugin]));
        const nextPlugins = [...plugins]
            .sort((left, right) => compareText(left.folder, right.folder))
            .map((plugin) => {
                const projected = projectPlugin(plugin, previous.get(plugin.folder));
                return samePlugin(previous.get(plugin.folder), projected)
                    ? previous.get(plugin.folder)!
                    : projected;
            });
        const nextApps = nextPlugins.flatMap((plugin) => plugin.apps).sort(compareApps);
        const nextFailures = failures
            .map((failure) => ({ error: failure.error, pluginId: failure.folder }))
            .sort((left, right) => compareText(left.pluginId, right.pluginId));
        const unchanged =
            sameReferences(this.#plugins, nextPlugins) &&
            sameReferences(this.#apps, nextApps) &&
            this.#state.connection === connection &&
            sameFailures(this.#state.failures, nextFailures);
        if (unchanged) return false;
        this.#plugins = nextPlugins;
        this.#apps = nextApps;
        this.#state = {
            connection,
            failures: sameFailures(this.#state.failures, nextFailures)
                ? this.#state.failures
                : nextFailures,
        };
        return true;
    }

    setConnection(connection: ConnectionState): boolean {
        if (this.#state.connection === connection) return false;
        this.#state = { ...this.#state, connection };
        return true;
    }
}

function projectPlugin(plugin: PluginSummary, previous: LocalPlugin | undefined): LocalPlugin {
    const previousApps = new Map(previous?.apps.map((app) => [app.id, app]) ?? []);
    const apps = plugin.apps.map((app) => {
        const projected = projectApp(Value.Decode(pluginAppContributionSchema, app));
        const before = previousApps.get(projected.id);
        return sameApp(before, projected) ? before! : projected;
    });
    return {
        apps: previous !== undefined && sameReferences(previous.apps, apps) ? previous.apps : apps,
        dataDirectory: plugin.dataDirectory,
        description: plugin.description,
        directory: plugin.directory,
        ...(plugin.error === undefined ? {} : { error: plugin.error }),
        id: plugin.folder,
        logAvailable: plugin.logAvailable,
        name: plugin.name,
        status: plugin.status,
    };
}

function projectApp(app: PluginAppContribution): PluginApp {
    return {
        appId: app.appId,
        generation: app.generation,
        id: app.id,
        page: app.page,
        pluginId: app.pluginFolder,
        resourceUri: app.resourceUri,
        resources: app.resources,
        sidebar: app.sidebar,
        title: app.title,
        tools: app.tools,
    };
}

function samePlugin(left: LocalPlugin | undefined, right: LocalPlugin): boolean {
    return (
        left !== undefined &&
        left.apps === right.apps &&
        left.dataDirectory === right.dataDirectory &&
        left.description === right.description &&
        left.directory === right.directory &&
        left.error === right.error &&
        left.id === right.id &&
        left.logAvailable === right.logAvailable &&
        left.name === right.name &&
        left.status === right.status
    );
}

function sameApp(left: PluginApp | undefined, right: PluginApp): boolean {
    return (
        left !== undefined &&
        left.appId === right.appId &&
        left.generation === right.generation &&
        left.id === right.id &&
        left.page === right.page &&
        left.pluginId === right.pluginId &&
        left.resourceUri === right.resourceUri &&
        left.sidebar.icon === right.sidebar.icon &&
        left.sidebar.label === right.sidebar.label &&
        left.sidebar.order === right.sidebar.order &&
        sameResources(left.resources, right.resources) &&
        left.title === right.title &&
        JSON.stringify(left.tools) === JSON.stringify(right.tools)
    );
}

function sameResources(
    left: readonly PluginAppResource[],
    right: readonly PluginAppResource[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (resource, index) =>
                resource.mimeType === right[index]?.mimeType &&
                resource.path === right[index]?.path &&
                resource.size === right[index]?.size &&
                resource.uri === right[index]?.uri,
        )
    );
}

function sameFailures(
    left: readonly PluginCatalogFailure[],
    right: readonly PluginCatalogFailure[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (failure, index) =>
                failure.error === right[index]?.error &&
                failure.pluginId === right[index]?.pluginId,
        )
    );
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareApps(left: PluginApp, right: PluginApp): number {
    return (
        left.sidebar.order - right.sidebar.order ||
        compareText(left.sidebar.label, right.sidebar.label) ||
        compareText(left.pluginId, right.pluginId) ||
        compareText(left.appId, right.appId)
    );
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
