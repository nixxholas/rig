import { type Static, Type } from "@sinclair/typebox";

import {
    happyPluginManifestSchema,
    happyPluginVersionSchema,
    type HappyPluginAppManifest,
    type HappyPluginManifest,
    type HappyPluginAppSidebar,
    type HappyPluginResourceMediaType,
} from "happy-plugins";

export type PluginAppManifest = HappyPluginAppManifest;

export const PLUGIN_MANIFEST_FILE_NAME = "happy.plugin.json";

export const pluginManifestSchema = happyPluginManifestSchema;
export type PluginManifest = HappyPluginManifest;
export const pluginVersionSchema = happyPluginVersionSchema;
export type RegisteredPluginManifest = PluginManifest & Required<Pick<PluginManifest, "version">>;

export const fileSystemErrorSchema = Type.Object({
    code: Type.String(),
});

export const pluginDockerRuntimeSchema = Type.Union([
    Type.Object(
        {
            dockerfilePath: Type.String(),
            type: Type.Literal("dockerfile"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            image: Type.String(),
            type: Type.Literal("image"),
        },
        { additionalProperties: false },
    ),
]);
export type PluginDockerRuntime = Static<typeof pluginDockerRuntimeSchema>;

export interface RegisteredPlugin {
    directory: string;
    docker?: PluginDockerRuntime;
    entryPath?: string;
    folderName: string;
    icon: PluginIconSummary;
    iconPath: string;
    manifest: RegisteredPluginManifest;
    manifestPath: string;
    skillsPath?: string;
    systemPrompt?: string;
}

export interface PluginIconSummary {
    generation: string;
    mediaType: "image/png";
    size: number;
}

export interface PluginIconResource extends PluginIconSummary {
    body: Buffer;
}

export interface PluginAppResourceSnapshot {
    body: Buffer;
    mediaType: HappyPluginResourceMediaType;
    path: string;
}

export interface PluginAppSnapshot {
    id: string;
    page: string;
    resources: readonly PluginAppResourceSnapshot[];
    resourceUri: string;
    sidebar: HappyPluginAppSidebar;
    title: string;
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

export interface PluginRuntimeSnapshot extends RegisteredPlugin {
    apps: readonly PluginAppSnapshot[];
}
