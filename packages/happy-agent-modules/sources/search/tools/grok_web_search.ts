import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { searchPageSchema } from "../Search.js";
import type { SearchModule } from "../SearchModule.js";

const inputSchema = Type.Object(
    {
        query: Type.String({ minLength: 2, maxLength: 20_000 }),
        include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        provider_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);

type Input = Static<typeof inputSchema>;

export function grokWebSearchTool(search: SearchModule, agentId: string) {
    return defineAgentTool({
        name: "grok_web_search",
        description:
            "Search published web pages through Grok. Use Grok X search for posts and social reaction.",
        parameters: inputSchema,
        returnType: searchPageSchema,
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Grok for "${query}". Access: external provider network`,
        execute: async (ctx, input: Input) =>
            await search.providerSearch(ctx, agentId, {
                provider: "grok",
                query: input.query,
                ...(input.include_domains === undefined
                    ? {}
                    : { allowedDomains: input.include_domains }),
                ...(input.provider_id === undefined ? {} : { providerId: input.provider_id }),
            }),
        toLLM: (page) => [{ type: "text", text: search.formatSearchForModel(page) }],
    });
}
