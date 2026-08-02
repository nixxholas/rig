import { Type, type Static } from "@sinclair/typebox";

import { pluginVersionSchema } from "./types.js";

export const HAPPY_PLUGINS_INDEX_FILE_NAME = "happy-plugins.json";
export const MAXIMUM_GITHUB_PLUGIN_INDEX_BYTES = 1024 * 1024;

export const githubRepositorySchema = Type.String({
    description: "GitHub repository in owner/repo form.",
    maxLength: 201,
    pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,99})/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$",
});

export const githubGitRefSchema = Type.String({
    description: "Git branch, tag, or commit. Defaults to the repository's default branch.",
    maxLength: 1024,
    minLength: 1,
    pattern:
        "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._/-]*[A-Za-z0-9._-]$",
});

export const githubPluginNameSchema = Type.String({
    description: "Plugin folder name from happy-plugins.json.",
    maxLength: 128,
    minLength: 1,
});

export const githubPluginSourceSchema = Type.Object(
    {
        ref: Type.Optional(githubGitRefSchema),
        repository: githubRepositorySchema,
    },
    { additionalProperties: false },
);
export type GitHubPluginSource = Static<typeof githubPluginSourceSchema>;

export const githubPluginInstallSourceSchema = Type.Object(
    {
        plugin: githubPluginNameSchema,
        ref: Type.Optional(githubGitRefSchema),
        repository: githubRepositorySchema,
    },
    { additionalProperties: false },
);
export type GitHubPluginInstallSource = Static<typeof githubPluginInstallSourceSchema>;

export const githubPluginCatalogEntrySchema = Type.Object(
    {
        description: Type.String({ maxLength: 4096, minLength: 1 }),
        displayName: Type.String({ maxLength: 128, minLength: 1 }),
        name: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$",
        }),
        path: Type.String({
            maxLength: 1024,
            minLength: 1,
            pattern:
                "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*\\\\)(?:[^/]+/)*[^/]+$",
        }),
        version: pluginVersionSchema,
    },
    { additionalProperties: false },
);
export type GitHubPluginCatalogEntry = Static<typeof githubPluginCatalogEntrySchema>;

export const githubPluginIndexSchema = Type.Object(
    {
        plugins: Type.Array(githubPluginCatalogEntrySchema, {
            maxItems: 1_000,
            uniqueItems: true,
        }),
    },
    { additionalProperties: false },
);
export type GitHubPluginIndex = Static<typeof githubPluginIndexSchema>;
