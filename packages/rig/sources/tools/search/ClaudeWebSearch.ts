import { Type, type Static } from "@sinclair/typebox";
import type { SessionTool } from "@slopus/happy-providers";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import type { SearchProviderRoutes } from "./OneOffInferenceRoute.js";
import { runOneOffInference } from "./runOneOffInference.js";
import { searchProviderSelection } from "./searchProviderSelection.js";
import { sessionOutputText } from "./sessionOutputText.js";

const claudeSearchQueryArguments = Type.Object(
    {
        query: Type.String({ minLength: 2, description: "The web query Claude should search for" }),
        allowed_domains: Type.Optional(
            Type.Array(Type.String(), {
                description: "Only use results from these domains",
            }),
        ),
        blocked_domains: Type.Optional(
            Type.Array(Type.String(), {
                description: "Do not use results from these domains",
            }),
        ),
    },
    { additionalProperties: false },
);

const claudeSearchResult = Type.Object({
    query: Type.String(),
    response: Type.String(),
    sources: Type.Array(Type.Object({ title: Type.String(), url: Type.String() })),
    durationSeconds: Type.Number(),
});

type ClaudeSearchResult = Static<typeof claudeSearchResult>;

const claudeNativeWebSearch = {
    name: "WebSearch",
    server: { type: "WebSearch" },
} as const satisfies SessionTool;

export function createClaudeWebSearchTool(options: SearchProviderRoutes) {
    const selection = searchProviderSelection("Claude", options);
    const argumentsSchema = selection.providerIdIsOptional
        ? Type.Object(
              {
                  ...claudeSearchQueryArguments.properties,
                  provider_id: Type.Optional(selection.providerIdSchema),
              },
              { additionalProperties: false },
          )
        : Type.Object(
              {
                  ...claudeSearchQueryArguments.properties,
                  provider_id: selection.providerIdSchema,
              },
              { additionalProperties: false },
          );
    return defineTool({
        name: "claude_web_search",
        label: "Claude web search",
        description: `Search the current web through Claude.

Use this for recent facts and documentation. Cite the returned sources as markdown links.
${selection.availability}`,
        arguments: argumentsSchema,
        returnType: claudeSearchResult,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Claude for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async (input, _context, execution): Promise<ClaudeSearchResult> => {
            if (input.allowed_domains?.length && input.blocked_domains?.length) {
                throw new Error("Claude search cannot allow and block domains in one request.");
            }
            const route = selection.selectRoute(input.provider_id);
            let searched = false;
            const providerSources = new Map<string, { title: string; url: string }>();
            const result = await runOneOffInference(execution.ctx, {
                instructions:
                    "Perform exactly one web research task. Use WebSearch before answering and cite every source.",
                onEvent: (event) => {
                    if (event.type === "toolcall_start" && event.server === true) searched = true;
                    if (event.type === "toolcall_result_end") {
                        collectClaudeResultSources(
                            sessionOutputText(event.content),
                            providerSources,
                        );
                    }
                },
                prompt: claudePrompt(input),
                route,
                ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                tools: [claudeNativeWebSearch],
            });
            if (!searched) {
                throw new Error(
                    `Claude answered the query "${input.query}" without running WebSearch.`,
                );
            }
            for (const source of claudeMarkdownSources(result.text)) {
                providerSources.set(source.url, source);
            }
            return {
                durationSeconds: result.durationMs / 1000,
                query: input.query,
                response: result.text,
                sources: [...providerSources.values()],
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: [
                    result.response,
                    "",
                    `Claude sources: ${JSON.stringify(result.sources)}`,
                    "Cite the relevant sources above as markdown links.",
                ].join("\n"),
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
            `Claude searched the web and returned ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}`,
        locks: [],
    });
}

function claudePrompt(input: Static<typeof claudeSearchQueryArguments>): string {
    return [
        `Search the web for: ${input.query}`,
        ...(input.allowed_domains === undefined
            ? []
            : [`Only use these domains: ${input.allowed_domains.join(", ")}.`]),
        ...(input.blocked_domains === undefined
            ? []
            : [`Do not use these domains: ${input.blocked_domains.join(", ")}.`]),
        "Give a concise answer and finish with every source as a markdown link.",
    ].join("\n");
}

function collectClaudeResultSources(
    result: string,
    sources: Map<string, { title: string; url: string }>,
): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(result);
    } catch {
        return;
    }
    const pending = [parsed];
    while (pending.length > 0) {
        const value = pending.pop();
        if (Array.isArray(value)) {
            pending.push(...value);
            continue;
        }
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        if (typeof record.url === "string") {
            const title = typeof record.title === "string" ? record.title : record.url;
            sources.set(record.url, { title, url: record.url });
        }
        pending.push(...Object.values(record));
    }
}

function claudeMarkdownSources(text: string): { title: string; url: string }[] {
    return [...text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu)].flatMap((match) =>
        match[1] === undefined || match[2] === undefined
            ? []
            : [{ title: match[1].trim(), url: match[2] }],
    );
}
