import { describe, expect, it, vi } from "vitest";

import { discoverGitHubPlugins } from "../discoverGitHubPlugins.js";
import type { GitHubFetch } from "../fetchBoundedGitHubResource.js";
import { MAXIMUM_GITHUB_PLUGIN_INDEX_BYTES } from "../githubPluginCatalog.js";

const validIndex = {
    plugins: [
        {
            description: "A small clock.",
            displayName: "Clock",
            name: "clock",
            path: "plugins/clock",
            version: "1.2.0",
        },
    ],
};
const REVISION = "a".repeat(40);

describe("discovering plugins from GitHub", () => {
    it("fetches and validates the repository index at the default branch", async () => {
        const fetcher = githubFetcher(validIndex);

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).resolves.toMatchObject({
            plugins: validIndex.plugins,
            repository: "happy-dev/plugins",
            revision: REVISION,
        });
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
            "https://api.github.com/repos/happy-dev/plugins/commits/HEAD",
            `https://raw.githubusercontent.com/happy-dev/plugins/${REVISION}/happy-plugins.json`,
        ]);
        expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    });

    it("keeps slashes in a validated explicit ref", async () => {
        const fetcher = githubFetcher(validIndex);

        await discoverGitHubPlugins(
            { ref: "release/1.0", repository: "happy-dev/plugins" },
            { fetcher },
        );

        expect(fetcher.mock.calls[0]?.[0]).toBe(
            "https://api.github.com/repos/happy-dev/plugins/commits/release%2F1.0",
        );
    });

    it("rejects traversal segments in a ref before fetching", async () => {
        const fetcher = githubFetcher(validIndex);

        await expect(
            discoverGitHubPlugins(
                { ref: "release/../1.0", repository: "happy-dev/plugins" },
                { fetcher },
            ),
        ).rejects.toThrow("valid git ref");
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("fails closed when the index does not match the TypeBox catalog schema", async () => {
        const fetcher = githubFetcher({
            plugins: [
                {
                    ...validIndex.plugins[0],
                    path: "../clock",
                },
            ],
        });

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("does not match the required plugin catalog format");
    });

    it("rejects entries that would target the same installed plugin identity", async () => {
        const fetcher = githubFetcher({
            plugins: [
                validIndex.plugins[0],
                {
                    ...validIndex.plugins[0],
                    name: "Clock",
                    path: "other/clock",
                },
            ],
        });

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("duplicate plugin identities");
    });

    it("rejects an index whose streamed body exceeds the size limit", async () => {
        const fetcher = vi.fn<GitHubFetch>(async (url) =>
            url.includes("/commits/")
                ? jsonResponse({ sha: REVISION })
                : new Response(new Uint8Array(MAXIMUM_GITHUB_PLUGIN_INDEX_BYTES + 1), {
                      status: 200,
                  }),
        );

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("larger than the 1 MB download limit");
    });

    it("reports a missing index in human-readable English", async () => {
        const fetcher = vi.fn<GitHubFetch>(async (url) =>
            url.includes("/commits/")
                ? jsonResponse({ sha: REVISION })
                : new Response("missing", { status: 404 }),
        );

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("has no happy-plugins.json index");
    });

    it("refuses redirects outside the fixed GitHub host allowlist", async () => {
        const fetcher = vi.fn<GitHubFetch>(
            async () =>
                new Response(null, {
                    headers: { location: "http://127.0.0.1/private" },
                    status: 302,
                }),
        );

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("outside the allowed GitHub hosts");
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

function githubFetcher(index: unknown) {
    return vi.fn<GitHubFetch>(async (url) =>
        url.includes("/commits/") ? jsonResponse({ sha: REVISION }) : jsonResponse(index),
    );
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}
