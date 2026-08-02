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

describe("discovering plugins from GitHub", () => {
    it("fetches and validates the repository index at the default branch", async () => {
        const fetcher = vi.fn<GitHubFetch>(async () => jsonResponse(validIndex));

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).resolves.toEqual(validIndex);
        expect(fetcher).toHaveBeenCalledWith(
            "https://raw.githubusercontent.com/happy-dev/plugins/HEAD/happy-plugins.json",
            expect.objectContaining({ redirect: "follow" }),
        );
    });

    it("keeps slashes in a validated explicit ref", async () => {
        const fetcher = vi.fn<GitHubFetch>(async () => jsonResponse(validIndex));

        await discoverGitHubPlugins(
            { ref: "release/1.0", repository: "happy-dev/plugins" },
            { fetcher },
        );

        expect(fetcher.mock.calls[0]?.[0]).toBe(
            "https://raw.githubusercontent.com/happy-dev/plugins/release/1.0/happy-plugins.json",
        );
    });

    it("rejects traversal segments in a ref before fetching", async () => {
        const fetcher = vi.fn<GitHubFetch>(async () => jsonResponse(validIndex));

        await expect(
            discoverGitHubPlugins(
                { ref: "release/../1.0", repository: "happy-dev/plugins" },
                { fetcher },
            ),
        ).rejects.toThrow("valid git ref");
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("fails closed when the index does not match the TypeBox catalog schema", async () => {
        const fetcher = vi.fn<GitHubFetch>(async () =>
            jsonResponse({
                plugins: [
                    {
                        ...validIndex.plugins[0],
                        path: "../clock",
                    },
                ],
            }),
        );

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("does not match the required plugin catalog format");
    });

    it("rejects an index whose streamed body exceeds the size limit", async () => {
        const fetcher = vi.fn<GitHubFetch>(
            async () =>
                new Response(new Uint8Array(MAXIMUM_GITHUB_PLUGIN_INDEX_BYTES + 1), {
                    status: 200,
                }),
        );

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("larger than the 1 MB download limit");
    });

    it("reports a missing index in human-readable English", async () => {
        const fetcher = vi.fn<GitHubFetch>(async () => new Response("missing", { status: 404 }));

        await expect(
            discoverGitHubPlugins({ repository: "happy-dev/plugins" }, { fetcher }),
        ).rejects.toThrow("has no happy-plugins.json index");
    });
});

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}
