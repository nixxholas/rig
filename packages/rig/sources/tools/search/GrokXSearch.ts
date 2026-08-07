import { Type, type Static } from "@sinclair/typebox";
import type { SessionTool } from "@slopus/rig-providers";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import {
    grokProviderIdIsOptional,
    grokProviderIdSchema,
    grokProviderIds,
    selectGrokRoute,
} from "./GrokProviderRoutes.js";
import type { SearchProviderRoutes } from "./OneOffInferenceRoute.js";
import { runOneOffInference } from "./runOneOffInference.js";

const grokXSearchQueryArguments = Type.Object(
    {
        query: Type.String({ minLength: 2, description: "The topic to search for on X" }),
        latest: Type.Optional(
            Type.Boolean({ description: "Prefer the newest posts over relevance" }),
        ),
    },
    { additionalProperties: false },
);

const grokXSearchResult = Type.Object({
    query: Type.String(),
    summary: Type.String(),
    posts: Type.Array(
        Type.Object({
            url: Type.String(),
            label: Type.String(),
        }),
    ),
    durationSeconds: Type.Number(),
});

type GrokXSearchResult = Static<typeof grokXSearchResult>;

const grokNativeXSearch = {
    name: "x_search",
    server: { type: "x_search" },
} as const satisfies SessionTool;

export function createGrokXSearchTool(options: SearchProviderRoutes) {
    const providerIds = grokProviderIds(options);
    const providerId = grokProviderIdSchema(options);
    const argumentsSchema = grokProviderIdIsOptional(options)
        ? Type.Object(
              {
                  ...grokXSearchQueryArguments.properties,
                  provider_id: Type.Optional(providerId),
              },
              { additionalProperties: false },
          )
        : Type.Object(
              {
                  ...grokXSearchQueryArguments.properties,
                  provider_id: providerId,
              },
              { additionalProperties: false },
          );
    return defineTool({
        name: "grok_x_search",
        label: "Grok X search",
        description: `Search posts and discussion on X through Grok. Use this for reactions, opinion, and breaking conversation.

Available Grok provider IDs: ${providerIds.join(", ")}.`,
        arguments: argumentsSchema,
        returnType: grokXSearchResult,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching X through Grok for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async (input, _context, execution): Promise<GrokXSearchResult> => {
            const route = selectGrokRoute(options, input.provider_id);
            let searchedX = false;
            const providerResults: string[] = [];
            const response = await runOneOffInference({
                instructions:
                    "Use x_search to inspect posts on X. Return a concise synthesis and link every post you rely on.",
                onEvent: (event) => {
                    if (event.type === "toolcall_start" && event.server === true) searchedX = true;
                    if (event.type === "toolcall_result_end") providerResults.push(event.result);
                },
                prompt: grokXPrompt(input),
                route,
                ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                tools: [grokNativeXSearch],
            });
            if (!searchedX) throw new Error(`Grok did not search X for "${input.query}".`);
            return {
                durationSeconds: response.durationMs / 1000,
                posts: grokXPosts(response.text, providerResults),
                query: input.query,
                summary: response.text,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.summary}\n\nX posts: ${JSON.stringify(result.posts)}`,
            },
        ],
        toCallPresentation: ({ query }) => ({ query, target: "x", type: "search" }),
        toPresentation: (result) => ({
            query: result.query,
            sources: result.posts.map((post) => ({ title: post.label, url: post.url })),
            target: "x",
            type: "search",
        }),
        toUI: (result) =>
            `Grok searched X and returned ${result.posts.length} post${result.posts.length === 1 ? "" : "s"}`,
        sharedOutputDisclosable: true,
        locks: [],
    });
}

function grokXPrompt(input: Static<typeof grokXSearchQueryArguments>): string {
    return [
        `Search X for posts about: ${input.query}`,
        input.latest === true ? "Prefer the latest posts." : "Prefer the most relevant posts.",
        "Summarize the discussion and include direct x.com links.",
    ].join("\n");
}

function grokXPosts(
    text: string,
    providerResults: readonly string[],
): { label: string; url: string }[] {
    const posts = new Map<string, { label: string; url: string }>();
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/(?:www\.)?x\.com\/[^\s)]+)\)/gu)) {
        if (match[1] !== undefined && match[2] !== undefined) {
            posts.set(match[2], { label: match[1].trim(), url: match[2] });
        }
    }
    for (const result of providerResults) {
        for (const match of result.matchAll(/https?:\/\/(?:www\.)?x\.com\/[^\s"\\]+/gu)) {
            posts.set(match[0], { label: "X post", url: match[0] });
        }
    }
    return [...posts.values()];
}
