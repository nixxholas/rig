import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SessionTool } from "@slopus/rig-providers";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import type { SearchProviderRoutes } from "./OneOffInferenceRoute.js";
import { runOneOffInference } from "./runOneOffInference.js";
import { searchProviderSelection } from "./searchProviderSelection.js";

const bedrockSearchQueryArguments = Type.Object(
    {
        query: Type.String({
            minLength: 2,
            description: "The question Bedrock should answer from the web",
        }),
    },
    { additionalProperties: false },
);

const bedrockSearchResult = Type.Object({
    query: Type.String(),
    answer: Type.String(),
    citations: Type.Array(Type.Object({ title: Type.String(), url: Type.String() })),
    durationMs: Type.Number(),
});

type BedrockSearchResult = Static<typeof bedrockSearchResult>;

/**
 * Bedrock's own hosted search, served from the index and page cache Amazon runs inside AWS.
 *
 * `external_web_access` is left off deliberately. Bedrock defaults it to `true` to match the
 * OpenAI Responses API, but the managed `AmazonBedrockFullAccess` policy does not grant
 * `bedrock-websearch:ExternalWebAccess`, so the default answers `403 AccessDenied` on the
 * authorization check for most identities. Off is what works everywhere, and it is also the
 * setting that keeps the request inside the AWS boundary.
 */
const bedrockNativeWebSearch = {
    name: "web_search",
    server: { type: "web_search", external_web_access: false },
} as const satisfies SessionTool;

export function createBedrockWebSearchTool(options: SearchProviderRoutes) {
    const selection = searchProviderSelection("Bedrock", options);
    const argumentsSchema = selection.providerIdIsOptional
        ? Type.Object(
              {
                  ...bedrockSearchQueryArguments.properties,
                  provider_id: Type.Optional(selection.providerIdSchema),
              },
              { additionalProperties: false },
          )
        : Type.Object(
              {
                  ...bedrockSearchQueryArguments.properties,
                  provider_id: selection.providerIdSchema,
              },
              { additionalProperties: false },
          );
    return defineTool({
        name: "bedrock_web_search",
        label: "Bedrock web search",
        description: `Search the web through Amazon Bedrock's hosted index.

Answers are grounded in Amazon's own web index and page cache and come back with source citations. Retrieval stays inside AWS, so this reads a recent snapshot of the web rather than fetching pages live.
${selection.availability}`,
        arguments: argumentsSchema,
        returnType: bedrockSearchResult,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Amazon Bedrock for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async (input, _context, execution): Promise<BedrockSearchResult> => {
            const route = selection.selectRoute(input.provider_id);
            let usedSearch = false;
            const responseItems: string[] = [];
            const result = await runOneOffInference({
                instructions:
                    "Search the web before answering. Return a compact factual answer and cite every source you used.",
                onEvent: (event) => {
                    if (event.type === "toolcall_start" && event.server === true) usedSearch = true;
                    if (event.type === "response_items") responseItems.push(...event.items);
                },
                prompt: bedrockPrompt(input),
                route,
                ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                tools: [bedrockNativeWebSearch],
            });
            if (!usedSearch) {
                throw new Error(`Bedrock did not search for "${input.query}".`);
            }
            return {
                answer: result.text,
                citations: bedrockCitations(responseItems, result.text),
                durationMs: result.durationMs,
                query: input.query,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.answer}\n\nBedrock citations: ${JSON.stringify(result.citations)}`,
            },
        ],
        toCallPresentation: ({ query }) => ({ query, target: "web", type: "search" }),
        toPresentation: (result) => ({
            query: result.query,
            sources: result.citations.map((citation) => ({
                title: citation.title,
                url: citation.url,
            })),
            target: "web",
            type: "search",
        }),
        toUI: (result) =>
            `Bedrock returned ${result.citations.length} citation${result.citations.length === 1 ? "" : "s"}`,
        locks: [],
    });
}

function bedrockPrompt(input: Static<typeof bedrockSearchQueryArguments>): string {
    return `Research this query and answer it: ${input.query}`;
}

/**
 * Bedrock reports its sources as `url_citation` annotations on the answer text, so they are read
 * back out of the provider's own response items rather than scraped from prose. Links the model
 * wrote inline are picked up too, since a cited source is worth keeping either way.
 */
function bedrockCitations(
    responseItems: readonly string[],
    text: string,
): { title: string; url: string }[] {
    const citations = new Map<string, { title: string; url: string }>();
    for (const serialized of responseItems) {
        let item: unknown;
        try {
            item = JSON.parse(serialized);
        } catch {
            continue;
        }
        for (const annotation of messageAnnotations(item)) {
            citations.set(annotation.url, annotation);
        }
    }
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu)) {
        const [, title, url] = match;
        if (title !== undefined && url !== undefined && !citations.has(url)) {
            citations.set(url, { title: title.trim(), url });
        }
    }
    return [...citations.values()];
}

const urlCitationAnnotation = Type.Object({
    type: Type.Literal("url_citation"),
    title: Type.Optional(Type.String()),
    url: Type.String(),
});

const annotatedMessageItem = Type.Object({
    type: Type.Literal("message"),
    content: Type.Array(
        Type.Object({
            annotations: Type.Optional(Type.Array(Type.Unknown())),
        }),
    ),
});

function messageAnnotations(item: unknown): { title: string; url: string }[] {
    if (!Value.Check(annotatedMessageItem, item)) return [];
    const annotations: { title: string; url: string }[] = [];
    for (const block of item.content) {
        for (const annotation of block.annotations ?? []) {
            if (!Value.Check(urlCitationAnnotation, annotation)) continue;
            annotations.push({ title: annotation.title ?? annotation.url, url: annotation.url });
        }
    }
    return annotations;
}
