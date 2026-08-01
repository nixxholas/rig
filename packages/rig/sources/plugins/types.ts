import { type Static, Type } from "@sinclair/typebox";

export const PLUGIN_MANIFEST_FILE_NAME = "happy.plugin.json";

export const pluginManifestSchema = Type.Object(
    {
        description: Type.String({ minLength: 1 }),
        entry: Type.String({ pattern: "^(?!.*\\.d\\.ts$).+\\.ts$" }),
        icon: Type.String({ pattern: "^.+\\.[pP][nN][gG]$" }),
        name: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
export type PluginManifest = Static<typeof pluginManifestSchema>;

export const fileSystemErrorSchema = Type.Object({
    code: Type.String(),
});

export interface RegisteredPlugin {
    directory: string;
    entryPath: string;
    folderName: string;
    iconPath: string;
    manifest: PluginManifest;
    manifestPath: string;
}

export interface PluginRegistrationFailure {
    directory: string;
    error: string;
    folderName: string;
}

export interface PluginDiscovery {
    plugins: readonly RegisteredPlugin[];
    failures: readonly PluginRegistrationFailure[];
}

export interface BuiltPlugin extends RegisteredPlugin {
    buildDirectory: string;
    builtEntryPath: string;
    runtimeDirectory: string;
}
