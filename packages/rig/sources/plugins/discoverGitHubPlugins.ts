import { createHash } from "node:crypto";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    githubPluginIndexSchema,
    githubPluginSourceSchema,
    HAPPY_PLUGINS_INDEX_FILE_NAME,
    MAXIMUM_GITHUB_PLUGIN_INDEX_BYTES,
    githubRevisionSchema,
    type ResolvedGitHubPluginIndex,
    type GitHubPluginSource,
} from "./githubPluginCatalog.js";
import {
    fetchBoundedGitHubResource,
    GitHubResourceFetchError,
    type GitHubFetch,
} from "./fetchBoundedGitHubResource.js";
import { PluginCatalogError } from "./PluginCatalogError.js";

export async function discoverGitHubPlugins(
    source: GitHubPluginSource,
    options: { fetcher?: GitHubFetch; signal?: AbortSignal } = {},
): Promise<ResolvedGitHubPluginIndex> {
    let validatedSource: GitHubPluginSource;
    try {
        validatedSource = Value.Decode(githubPluginSourceSchema, source);
    } catch {
        throw new PluginCatalogError(
            "invalid_source",
            "The GitHub plugin source must use owner/repo form and a valid git ref.",
        );
    }
    const revision = await resolveRevision(validatedSource, options);
    return discoverGitHubPluginsAtRevision(validatedSource, revision, options);
}

export async function discoverGitHubPluginsAtRevision(
    source: GitHubPluginSource,
    revision: string,
    options: { fetcher?: GitHubFetch; signal?: AbortSignal } = {},
): Promise<ResolvedGitHubPluginIndex> {
    let validatedSource: GitHubPluginSource;
    let validatedRevision: string;
    try {
        validatedSource = Value.Decode(githubPluginSourceSchema, source);
        validatedRevision = Value.Decode(githubRevisionSchema, revision);
    } catch {
        throw new PluginCatalogError(
            "invalid_source",
            "The GitHub plugin source must use owner/repo form, a valid git ref, and a resolved commit.",
        );
    }
    const url = `https://raw.githubusercontent.com/${validatedSource.repository}/${validatedRevision}/${HAPPY_PLUGINS_INDEX_FILE_NAME}`;
    let body: Uint8Array;
    try {
        body = await fetchBoundedGitHubResource({
            accept: "application/json",
            description: `${HAPPY_PLUGINS_INDEX_FILE_NAME} in ${validatedSource.repository}`,
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            maximumBytes: MAXIMUM_GITHUB_PLUGIN_INDEX_BYTES,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            url,
        });
    } catch (error) {
        if (error instanceof GitHubResourceFetchError && error.status === 404) {
            throw new PluginCatalogError(
                "catalog_not_found",
                `The GitHub repository ${validatedSource.repository} has no ${HAPPY_PLUGINS_INDEX_FILE_NAME} index at ${validatedSource.ref ?? validatedRevision}.`,
            );
        }
        if (error instanceof PluginCatalogError) throw error;
        if (error instanceof GitHubResourceFetchError) {
            throw new PluginCatalogError("source_unavailable", error.message);
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
        throw new PluginCatalogError(
            "catalog_invalid",
            `The ${HAPPY_PLUGINS_INDEX_FILE_NAME} index in ${validatedSource.repository} is not valid UTF-8 JSON.`,
        );
    }
    try {
        const index = Value.Decode(githubPluginIndexSchema, parsed);
        const names = new Set<string>();
        const paths = new Set<string>();
        for (const plugin of index.plugins) {
            const name = plugin.name.toLowerCase();
            if (names.has(name) || paths.has(plugin.path)) {
                throw new PluginCatalogError(
                    "catalog_invalid",
                    `The ${HAPPY_PLUGINS_INDEX_FILE_NAME} index in ${validatedSource.repository} contains duplicate plugin identities.`,
                );
            }
            names.add(name);
            paths.add(plugin.path);
        }
        return {
            catalogId: createHash("sha256").update(JSON.stringify(index)).digest("hex"),
            plugins: index.plugins,
            ...(validatedSource.ref === undefined ? {} : { ref: validatedSource.ref }),
            repository: validatedSource.repository,
            revision: validatedRevision,
        };
    } catch (error) {
        if (error instanceof PluginCatalogError) throw error;
        throw new PluginCatalogError(
            "catalog_invalid",
            `The ${HAPPY_PLUGINS_INDEX_FILE_NAME} index in ${validatedSource.repository} does not match the required plugin catalog format.`,
        );
    }
}

const githubCommitResponseSchema = Type.Object(
    { sha: githubRevisionSchema },
    { additionalProperties: true },
);

async function resolveRevision(
    source: GitHubPluginSource,
    options: { fetcher?: GitHubFetch; signal?: AbortSignal },
): Promise<string> {
    const ref = source.ref ?? "HEAD";
    const url = `https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(ref)}`;
    let body: Uint8Array;
    try {
        body = await fetchBoundedGitHubResource({
            accept: "application/vnd.github+json",
            description: `the resolved plugin source for ${source.repository}`,
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            maximumBytes: 1024 * 1024,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            url,
        });
    } catch (error) {
        if (error instanceof GitHubResourceFetchError && error.status === 404) {
            throw new PluginCatalogError(
                "repository_not_found",
                `GitHub could not find ${source.repository} at ${source.ref ?? "its default branch"}.`,
            );
        }
        if (error instanceof GitHubResourceFetchError) {
            throw new PluginCatalogError("source_unavailable", error.message);
        }
        throw error;
    }
    try {
        return Value.Decode(
            githubCommitResponseSchema,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
        ).sha;
    } catch {
        throw new PluginCatalogError(
            "source_unavailable",
            `GitHub returned an invalid resolved revision for ${source.repository}.`,
        );
    }
}
