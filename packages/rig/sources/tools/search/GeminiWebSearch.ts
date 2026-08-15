import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import {
    geminiSearchInputSchema,
    geminiSearchOutputSchema,
    type GeminiSearchInput,
    type GeminiSearchOutput,
} from "./GeminiWebSearchTypes.js";
import { performGeminiWebSearch } from "./performGeminiWebSearch.js";

export function createGeminiWebSearchTool(
    apiKey: string,
    dependencies: {
        search?: (input: GeminiSearchInput, signal?: AbortSignal) => Promise<GeminiSearchOutput>;
    } = {},
) {
    const search =
        dependencies.search ??
        ((input: GeminiSearchInput, signal?: AbortSignal) =>
            performGeminiWebSearch(input, {
                apiKey,
                ...(signal === undefined ? {} : { signal }),
            }));
    return defineTool({
        name: "gemini_web_search",
        label: "Gemini web search",
        description:
            "Search the live web through Gemini grounding and return a concise answer with cited sources.",
        arguments: geminiSearchInputSchema,
        returnType: geminiSearchOutputSchema,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Gemini for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async (input, _context, execution) => {
            if (input.allowed_domains?.length && input.blocked_domains?.length) {
                throw new Error("Gemini search cannot allow and block domains in one request.");
            }
            return search(input, execution.signal);
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.answer}\n\nGemini sources: ${JSON.stringify(result.sources)}`,
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
            `Gemini returned ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}`,
        locks: [],
    });
}
