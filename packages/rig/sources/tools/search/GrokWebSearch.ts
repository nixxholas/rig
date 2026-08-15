import { Type, type Static } from "@sinclair/typebox";
import type { SessionTool } from "@slopus/happy-providers";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import type { SearchProviderRoutes } from "./OneOffInferenceRoute.js";
import { runOneOffInference } from "./runOneOffInference.js";
import { searchProviderSelection } from "./searchProviderSelection.js";
import { sessionOutputText } from "./sessionOutputText.js";

const grokWebSearchQueryArguments = Type.Object(
    {
        query: Type.String({ minLength: 2, description: "The web query for Grok" }),
        include_domains: Type.Optional(
            Type.Array(Type.String(), {
                description: "Domains the web search should focus on",
            }),
        ),
    },
    { additionalProperties: false },
);

const grokWebSearchResult = Type.Object({
    query: Type.String(),
    answer: Type.String(),
    sources: Type.Array(Type.Object({ title: Type.String(), url: Type.String() })),
    elapsedMs: Type.Number(),
});

type GrokWebSearchResult = Static<typeof grokWebSearchResult>;

const grokNativeWebSearch = {
    name: "web_search",
    server: { type: "web_search" },
} as const satisfies SessionTool;

export function createGrokWebSearchTool(options: SearchProviderRoutes) {
    const selection = searchProviderSelection("Grok", options);
    const argumentsSchema = selection.providerIdIsOptional
        ? Type.Object(
              {
                  ...grokWebSearchQueryArguments.properties,
                  provider_id: Type.Optional(selection.providerIdSchema),
              },
              { additionalProperties: false },
          )
        : Type.Object(
              {
                  ...grokWebSearchQueryArguments.properties,
                  provider_id: selection.providerIdSchema,
              },
              { additionalProperties: false },
          );
    return defineTool({
        name: "grok_web_search",
        label: "Grok web search",
        description: `Search published web pages through Grok. Use Grok X search for posts and social reaction.

${selection.availability}`,
        arguments: argumentsSchema,
        returnType: grokWebSearchResult,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Grok for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async (input, _context, execution): Promise<GrokWebSearchResult> => {
            const route = selection.selectRoute(input.provider_id);
            let searchCalls = 0;
            const resultFragments: string[] = [];
            const response = await runOneOffInference(execution.ctx, {
                instructions:
                    "Use web_search to research published pages. Do not use X search. Return a concise answer with markdown links.",
                onEvent: (event) => {
                    if (event.type === "toolcall_start" && event.server === true) searchCalls += 1;
                    if (event.type === "toolcall_result_end") {
                        resultFragments.push(sessionOutputText(event.content));
                    }
                },
                prompt: grokWebPrompt(input),
                route,
                ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                tools: [grokNativeWebSearch],
            });
            if (searchCalls === 0)
                throw new Error(`Grok did not search the web for "${input.query}".`);
            return {
                answer: response.text,
                elapsedMs: response.durationMs,
                query: input.query,
                sources: grokWebSources(response.text, resultFragments),
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.answer}\n\nGrok web sources: ${JSON.stringify(result.sources)}`,
            },
        ],
        toCallPresentation: ({ query }) => ({ query, target: "web", type: "search" }),
        toPresentation: (result) => ({
            query: result.query,
            sources: result.sources,
            target: "web",
            type: "search",
        }),
        toUI: (result) =>
            `Grok searched the web and returned ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}`,
        locks: [],
    });
}

function grokWebPrompt(input: Static<typeof grokWebSearchQueryArguments>): string {
    return [
        `Search published web pages for: ${input.query}`,
        ...(input.include_domains === undefined
            ? []
            : [`Focus on these domains: ${input.include_domains.join(", ")}.`]),
        "Summarize the findings and cite every source as a markdown link.",
    ].join("\n");
}

function grokWebSources(
    text: string,
    resultFragments: readonly string[],
): { title: string; url: string }[] {
    const sources = new Map<string, { title: string; url: string }>();
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu)) {
        if (match[1] !== undefined && match[2] !== undefined) {
            sources.set(match[2], { title: match[1].trim(), url: match[2] });
        }
    }
    for (const fragment of resultFragments) {
        for (const match of fragment.matchAll(/https?:\/\/[^\s"\\]+/gu)) {
            sources.set(match[0], { title: match[0], url: match[0] });
        }
    }
    return [...sources.values()];
}
