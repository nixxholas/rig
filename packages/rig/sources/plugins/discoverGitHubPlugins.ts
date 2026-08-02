import { Value } from "@sinclair/typebox/value";

import {
    githubPluginIndexSchema,
    githubPluginSourceSchema,
    HAPPY_PLUGINS_INDEX_FILE_NAME,
    MAXIMUM_GITHUB_PLUGIN_INDEX_BYTES,
    type GitHubPluginIndex,
    type GitHubPluginSource,
} from "./githubPluginCatalog.js";
import {
    fetchBoundedGitHubResource,
    GitHubResourceFetchError,
    type GitHubFetch,
} from "./fetchBoundedGitHubResource.js";

export async function discoverGitHubPlugins(
    source: GitHubPluginSource,
    options: { fetcher?: GitHubFetch; signal?: AbortSignal } = {},
): Promise<GitHubPluginIndex> {
    let validatedSource: GitHubPluginSource;
    try {
        validatedSource = Value.Decode(githubPluginSourceSchema, source);
    } catch {
        throw new Error("The GitHub plugin source must use owner/repo form and a valid git ref.");
    }
    const ref = validatedSource.ref ?? "HEAD";
    const url = `https://raw.githubusercontent.com/${validatedSource.repository}/${ref}/${HAPPY_PLUGINS_INDEX_FILE_NAME}`;
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
            throw new Error(
                `The GitHub repository ${validatedSource.repository} has no ${HAPPY_PLUGINS_INDEX_FILE_NAME} index at ${validatedSource.ref ?? "its default branch"}.`,
            );
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
        throw new Error(
            `The ${HAPPY_PLUGINS_INDEX_FILE_NAME} index in ${validatedSource.repository} is not valid UTF-8 JSON.`,
        );
    }
    try {
        return Value.Decode(githubPluginIndexSchema, parsed);
    } catch {
        throw new Error(
            `The ${HAPPY_PLUGINS_INDEX_FILE_NAME} index in ${validatedSource.repository} does not match the required plugin catalog format.`,
        );
    }
}
