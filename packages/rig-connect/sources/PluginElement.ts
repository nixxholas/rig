import type { ConnectionState } from "./ChatElement.js";
import type {
    PluginApplicationContribution,
    PluginResourceMediaType,
    PluginSummary,
} from "./protocol.js";

export interface PluginApplicationResource {
    mediaType: PluginResourceMediaType;
    path: string;
    size: number;
}

/**
 * One stable local application identity.
 *
 * `generation` changes when plugin code is replaced or restarted. Hosts must include the
 * generation they rendered in resource and action calls so stale views fail closed.
 */
export interface PluginApplication {
    actions: readonly string[];
    applicationId: string;
    entry: string;
    generation: string;
    id: string;
    navigation: {
        icon?: string;
        label: string;
        order: number;
    };
    pluginId: string;
    resources: readonly PluginApplicationResource[];
    title: string;
}

export interface LocalPlugin {
    applications: readonly PluginApplication[];
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

export interface PluginsState {
    connection: ConnectionState;
    failures: readonly PluginCatalogFailure[];
}

export interface LoadedPluginApplicationResource {
    body: Uint8Array;
    mediaType: PluginResourceMediaType;
}

/** Immutable, reference-stable projection of the daemon's plugin catalog. */
export class PluginStore {
    #applications: readonly PluginApplication[] = [];
    #plugins: readonly LocalPlugin[] = [];
    #state: PluginsState = { connection: "connecting", failures: [] };

    applications(): readonly PluginApplication[] {
        return this.#applications;
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
        const nextApplications = nextPlugins
            .flatMap((plugin) => plugin.applications)
            .sort(compareApplications);
        const nextFailures = failures
            .map((failure) => ({ error: failure.error, pluginId: failure.folder }))
            .sort((left, right) => compareText(left.pluginId, right.pluginId));
        const unchanged =
            sameReferences(this.#plugins, nextPlugins) &&
            sameReferences(this.#applications, nextApplications) &&
            this.#state.connection === connection &&
            sameFailures(this.#state.failures, nextFailures);
        if (unchanged) return false;
        this.#plugins = nextPlugins;
        this.#applications = nextApplications;
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
    const previousApplications = new Map(
        previous?.applications.map((application) => [application.id, application]) ?? [],
    );
    const applications = plugin.applications.map((application) => {
        const projected = projectApplication(application);
        const before = previousApplications.get(projected.id);
        return sameApplication(before, projected) ? before! : projected;
    });
    return {
        applications:
            previous !== undefined && sameReferences(previous.applications, applications)
                ? previous.applications
                : applications,
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

function projectApplication(application: PluginApplicationContribution): PluginApplication {
    return {
        actions: application.actions,
        applicationId: application.applicationId,
        entry: application.entry,
        generation: application.generation,
        id: application.id,
        navigation: application.navigation,
        pluginId: application.pluginFolder,
        resources: application.resources,
        title: application.title,
    };
}

function samePlugin(left: LocalPlugin | undefined, right: LocalPlugin): boolean {
    return (
        left !== undefined &&
        left.applications === right.applications &&
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

function sameApplication(left: PluginApplication | undefined, right: PluginApplication): boolean {
    return (
        left !== undefined &&
        sameStrings(left.actions, right.actions) &&
        left.applicationId === right.applicationId &&
        left.entry === right.entry &&
        left.generation === right.generation &&
        left.id === right.id &&
        left.navigation.icon === right.navigation.icon &&
        left.navigation.label === right.navigation.label &&
        left.navigation.order === right.navigation.order &&
        left.pluginId === right.pluginId &&
        sameResources(left.resources, right.resources) &&
        left.title === right.title
    );
}

function sameResources(
    left: readonly PluginApplicationResource[],
    right: readonly PluginApplicationResource[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (resource, index) =>
                resource.mediaType === right[index]?.mediaType &&
                resource.path === right[index]?.path &&
                resource.size === right[index]?.size,
        )
    );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
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

function compareApplications(left: PluginApplication, right: PluginApplication): number {
    return (
        left.navigation.order - right.navigation.order ||
        compareText(left.navigation.label, right.navigation.label) ||
        compareText(left.pluginId, right.pluginId) ||
        compareText(left.applicationId, right.applicationId)
    );
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
