import { Type, type Static } from "@sinclair/typebox";
import type { SessionTool } from "@slopus/rig-providers";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import type { OneOffInferenceRoute, SearchProviderRoutes } from "./OneOffInferenceRoute.js";
import { runOneOffInference } from "./runOneOffInference.js";

const codexSearchQueryArguments = Type.Object(
    {
        query: Type.String({ minLength: 2, description: "The query Codex should research" }),
        domains: Type.Optional(
            Type.Array(Type.String(), {
                description: "Optional domains Codex should prioritize",
            }),
        ),
    },
    { additionalProperties: false },
);

const codexSearchResult = Type.Object({
    query: Type.String(),
    answer: Type.String(),
    citations: Type.Array(Type.Object({ label: Type.String(), href: Type.String() })),
    durationMs: Type.Number(),
});

type CodexSearchResult = Static<typeof codexSearchResult>;

const codexNativeWebSearch = {
    name: "web_search",
    server: {
        type: "web_search",
        external_web_access: false,
        search_content_types: ["text", "image"],
    },
} as const satisfies SessionTool;

export function createCodexWebSearchTool(options: SearchProviderRoutes) {
    const providerIds = codexProviderIds(options);
    const providerId = Type.String({
        description: `Codex provider to use. Available provider IDs: ${providerIds.join(", ")}`,
        enum: providerIds,
    });
    const currentProviderIsAvailable =
        options.currentProviderId !== undefined && providerIds.includes(options.currentProviderId);
    const argumentsSchema =
        providerIds.length > 1 && !currentProviderIsAvailable
            ? Type.Object(
                  {
                      ...codexSearchQueryArguments.properties,
                      provider_id: providerId,
                  },
                  { additionalProperties: false },
              )
            : Type.Object(
                  {
                      ...codexSearchQueryArguments.properties,
                      provider_id: Type.Optional(providerId),
                  },
                  { additionalProperties: false },
              );
    return defineTool({
        name: "codex_web_search",
        label: "Codex web search",
        description: `Research the live web through Codex.

Use it when current documentation, releases, or external facts need direct source attribution.
Available Codex provider IDs: ${providerIds.join(", ")}.`,
        arguments: argumentsSchema,
        returnType: codexSearchResult,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Codex for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async (input, _context, execution): Promise<CodexSearchResult> => {
            const route = selectCodexRoute(options, input.provider_id);
            let usedSearch = false;
            const resultPayloads: string[] = [];
            const result = await runOneOffInference({
                instructions:
                    "Use the provider's web search before answering. Return a compact factual answer with markdown source links.",
                onEvent: (event) => {
                    if (event.type === "toolcall_start" && event.server === true) usedSearch = true;
                    if (event.type === "toolcall_result_end") resultPayloads.push(event.result);
                },
                prompt: codexPrompt(input),
                route,
                ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                tools: [codexNativeWebSearch],
            });
            if (!usedSearch) {
                throw new Error(`Codex did not search for "${input.query}".`);
            }
            const citations = codexCitations(result.text, resultPayloads);
            return {
                answer: result.text,
                citations,
                durationMs: result.durationMs,
                query: input.query,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.answer}\n\nCodex citations: ${JSON.stringify(result.citations)}`,
            },
        ],
        toCallPresentation: ({ query }) => ({ query, target: "web", type: "search" }),
        toPresentation: (result) => ({
            query: result.query,
            sources: result.citations.map((citation) => ({
                title: citation.label,
                url: citation.href,
            })),
            target: "web",
            type: "search",
        }),
        toUI: (result) =>
            `Codex returned ${result.citations.length} citation${result.citations.length === 1 ? "" : "s"}`,
        locks: [],
    });
}

function codexProviderIds(options: SearchProviderRoutes): string[] {
    const providerIds = [...new Set(options.routes.map((route) => route.provider.id))];
    if (providerIds.length === 0) {
        throw new Error("Codex search requires at least one configured provider.");
    }
    return providerIds;
}

function selectCodexRoute(
    options: SearchProviderRoutes,
    requestedProviderId: string | undefined,
): OneOffInferenceRoute {
    const providerIds = codexProviderIds(options);
    const selectedProviderId =
        requestedProviderId ??
        (options.currentProviderId !== undefined && providerIds.includes(options.currentProviderId)
            ? options.currentProviderId
            : options.routes.length === 1
              ? options.routes[0]?.provider.id
              : undefined);
    if (selectedProviderId === undefined) {
        throw new Error(
            `Codex search requires provider_id. Available provider IDs: ${providerIds.join(", ")}.`,
        );
    }
    const route = options.routes.find((candidate) => candidate.provider.id === selectedProviderId);
    if (route === undefined) {
        throw new Error(
            `Unknown Codex provider '${selectedProviderId}'. Available provider IDs: ${providerIds.join(", ")}.`,
        );
    }
    return route;
}

function codexPrompt(input: Static<typeof codexSearchQueryArguments>): string {
    return [
        `Research this query: ${input.query}`,
        ...(input.domains === undefined
            ? []
            : [`Prioritize these domains: ${input.domains.join(", ")}.`]),
        "Use web search, explain the answer briefly, and include markdown links for every citation.",
    ].join("\n");
}

function codexCitations(
    text: string,
    payloads: readonly string[],
): { label: string; href: string }[] {
    const citations = new Map<string, { label: string; href: string }>();
    for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu)) {
        if (match[1] !== undefined && match[2] !== undefined) {
            citations.set(match[2], { label: match[1].trim(), href: match[2] });
        }
    }
    for (const payload of payloads) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            continue;
        }
        const values = [parsed];
        while (values.length > 0) {
            const value = values.pop();
            if (Array.isArray(value)) {
                values.push(...value);
                continue;
            }
            if (typeof value !== "object" || value === null) continue;
            const record = value as Record<string, unknown>;
            const href =
                typeof record.url === "string"
                    ? record.url
                    : typeof record.href === "string"
                      ? record.href
                      : undefined;
            if (href !== undefined) {
                const label =
                    typeof record.title === "string"
                        ? record.title
                        : typeof record.label === "string"
                          ? record.label
                          : href;
                citations.set(href, { href, label });
            }
            values.push(...Object.values(record));
        }
    }
    return [...citations.values()];
}
