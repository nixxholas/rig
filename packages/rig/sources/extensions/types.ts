import { type Static, Type } from "@sinclair/typebox";

export const EXTENSION_MANIFEST_FILE_NAME = "happy.plugin.json";

export const extensionManifestSchema = Type.Object(
    {
        description: Type.String({ minLength: 1 }),
        entry: Type.String({ pattern: "^(?!.*\\.d\\.ts$).+\\.ts$" }),
        icon: Type.String({ pattern: "^.+\\.[pP][nN][gG]$" }),
        name: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
export type ExtensionManifest = Static<typeof extensionManifestSchema>;

export const fileSystemErrorSchema = Type.Object({
    code: Type.String(),
});

export interface RegisteredExtension {
    directory: string;
    entryPath: string;
    folderName: string;
    iconPath: string;
    manifest: ExtensionManifest;
    manifestPath: string;
}

export interface ExtensionRegistrationFailure {
    directory: string;
    error: string;
    folderName: string;
}

export interface ExtensionDiscovery {
    extensions: readonly RegisteredExtension[];
    failures: readonly ExtensionRegistrationFailure[];
}

export interface BuiltExtension extends RegisteredExtension {
    buildDirectory: string;
    builtEntryPath: string;
    runtimeDirectory: string;
}
