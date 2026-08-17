import {
    type AgentModel,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentProviders,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    fetchInputSchema,
    fetchResultSchema,
    MAX_FETCH_CONTENT_CHARACTERS,
    MAX_FETCH_URL_LENGTH,
    searchAgentIdSchema,
    searchAnswerSchema,
    searchProviderRequestSchema,
    type FetchInput,
    type FetchResult,
    type SearchAnswer,
    type SearchProviderRequest,
} from "./Search.js";
import { bedrockWebSearch } from "./impl/bedrockWebSearch.js";
import { claudeWebSearch } from "./impl/claudeWebSearch.js";
import { codexWebSearch } from "./impl/codexWebSearch.js";
import { geminiWebSearch } from "./impl/geminiWebSearch.js";
import { grokWebSearch } from "./impl/grokWebSearch.js";
import { grokXSearch } from "./impl/grokXSearch.js";
import { resolveSearchRoutes } from "./impl/SearchRoute.js";
import type { VendorSearchContext } from "./impl/VendorSearchContext.js";
import { fetchWebPage } from "./impl/webFetch/fetchWebPage.js";
import { bedrockWebSearchTool } from "./tools/bedrock_web_search.js";
import { claudeWebSearchTool } from "./tools/claude_web_search.js";
import { codexWebSearchTool } from "./tools/codex_web_search.js";
import { geminiWebSearchTool } from "./tools/gemini_web_search.js";
import { grokWebSearchTool } from "./tools/grok_web_search.js";
import { grokXSearchTool } from "./tools/grok_x_search.js";
import { webFetchTool } from "./tools/web_fetch.js";

const DEFAULT_MAX_CHARACTERS = 40_000;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 12_000;
const MIN_MAX_OUTPUT_CHARACTERS = 256;
const MAX_MAX_OUTPUT_CHARACTERS = 100_000;
const FETCH_TRUNCATION_MARKER = "\n[Content truncated.]";
const ANSWER_TRUNCATION_MARKER = "\n[Answer truncated.]";
const SOURCES_HEADING = "\n\nSources:\n";

const providersSchema = Type.Unsafe<AgentProviders>(
    Type.Object({}, { additionalProperties: true }),
);
const agentModelSchema = Type.Unsafe<AgentModel>(
    Type.Object(
        {
            providerId: Type.String({ minLength: 1 }),
            id: Type.String({ minLength: 1 }),
            name: Type.String(),
            effortLevels: Type.Array(Type.String()),
            defaultEffort: Type.String(),
        },
        { additionalProperties: true },
    ),
);

const searchModuleOptionsSchema = Type.Object(
    {
        /** The accounts a vendor search may run on, and the credentials that reach them. */
        providers: providersSchema,
        /** The catalog the routes are drawn from; a vendor search uses its provider's first model. */
        models: Type.Unsafe<readonly AgentModel[]>(Type.Array(agentModelSchema)),
        /** The account this chat itself runs on, preferred whenever it serves the asked vendor. */
        currentProviderId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        /** Bedrock serves its hosted index from particular models, so an account may name its own. */
        bedrockSearchModels: Type.Optional(Type.Record(Type.String(), Type.String())),
        /** Gemini answers over its own HTTP API rather than through a configured chat provider. */
        geminiApiKey: Type.Optional(Type.String({ minLength: 1 })),
        maxCharacters: Type.Optional(
            Type.Integer({
                minimum: 1_000,
                maximum: MAX_FETCH_CONTENT_CHARACTERS,
            }),
        ),
        maxOutputCharacters: Type.Optional(
            Type.Integer({
                minimum: MIN_MAX_OUTPUT_CHARACTERS,
                maximum: MAX_MAX_OUTPUT_CHARACTERS,
            }),
        ),
    },
    { additionalProperties: false },
);

export { searchModuleOptionsSchema };
export type SearchModuleOptions = Static<typeof searchModuleOptionsSchema>;

/**
 * Web search and page fetch, run by the module itself.
 *
 * Each vendor tool spends one bounded call on that vendor's own search, on an account the person
 * already configured, and comes back with the answer it wrote and the sources it cited. Nothing
 * is delegated to a host: the module owns the routing, the inference, and the fetch.
 */
export class SearchModule implements AgentModule {
    readonly name = "search";
    readonly #search: VendorSearchContext;
    readonly #maxCharacters: number;
    readonly #maxOutputCharacters: number;

    constructor(options: SearchModuleOptions) {
        if (!Value.Check(searchModuleOptionsSchema, options)) {
            throw new Error("Search module options are invalid.");
        }
        this.#search = {
            providers: options.providers,
            routes: resolveSearchRoutes(options),
            ...(options.geminiApiKey === undefined ? {} : { geminiApiKey: options.geminiApiKey }),
        };
        this.#maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
    }

    async providerSearch(
        ctx: Context,
        agentId: string,
        request: SearchProviderRequest,
    ): Promise<SearchAnswer> {
        assertAgentId(agentId);
        if (!Value.Check(searchProviderRequestSchema, request)) {
            throw new Error("Invalid provider search request.");
        }
        if (
            request.allowedDomains !== undefined &&
            request.blockedDomains !== undefined &&
            request.allowedDomains.length > 0 &&
            request.blockedDomains.length > 0
        ) {
            throw new Error("A search cannot allow and block domains in the same request.");
        }
        const query = request.query.trim();
        if (query.length === 0) throw new Error("Search query cannot be empty.");
        const normalized: SearchProviderRequest = {
            provider: request.provider,
            query,
            ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            ...(request.allowedDomains === undefined
                ? {}
                : { allowedDomains: [...request.allowedDomains] }),
            ...(request.blockedDomains === undefined
                ? {}
                : { blockedDomains: [...request.blockedDomains] }),
            ...(request.latest === undefined ? {} : { latest: request.latest }),
        };
        const answer = await vendorSearch(ctx, this.#search, normalized);
        assertSearchAnswer(answer, normalized);
        /*
         * The formatter is part of the module boundary.  An answer whose sources cannot all be
         * shown within the configured model budget is still returned, but formatting is proven
         * here so a tool can never be handed something it cannot render.
         */
        this.formatSearchAnswerForModel(answer);
        return answer;
    }

    async fetch(_ctx: Context, agentId: string, input: FetchInput): Promise<FetchResult> {
        assertAgentId(agentId);
        const normalizedInput = normalizeFetchInput(input);
        const requestedCharacters = Math.min(
            normalizedInput.maxCharacters ?? this.#maxCharacters,
            this.#maxCharacters,
        );
        const normalized: FetchInput = {
            url: normalizedInput.url,
            maxCharacters: requestedCharacters,
        };
        const result = await fetchWebPage(normalized);
        if (!Value.Check(fetchResultSchema, result)) {
            throw new Error("The fetched page could not be represented as a fetch result.");
        }
        if (result.url !== normalized.url) {
            throw new Error("The fetch returned content for a different normalized URL.");
        }
        if (result.content.length <= requestedCharacters) return result;
        return {
            ...result,
            content: result.content.slice(0, requestedCharacters),
            truncated: true,
        };
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            webFetchTool(this, scope.agent.id),
            geminiWebSearchTool(this, scope.agent.id),
            claudeWebSearchTool(this, scope.agent.id),
            codexWebSearchTool(this, scope.agent.id),
            bedrockWebSearchTool(this, scope.agent.id),
            grokWebSearchTool(this, scope.agent.id),
            grokXSearchTool(this, scope.agent.id),
        ],
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /**
     * The vendor's answer first, then the sources it cited.
     *
     * The answer is what the model asked for, so it leads and keeps at least half of the output
     * budget. Sources follow as complete URLs; a URL is never cut to make room, and sources that
     * do not fit are counted rather than half-written.
     */
    formatSearchAnswerForModel(answer: SearchAnswer): string {
        if (!Value.Check(searchAnswerSchema, answer)) {
            throw new Error("Cannot format an invalid search answer.");
        }
        const sourcesBudget = Math.floor(this.#maxOutputCharacters / 2);
        const rows: string[] = [];
        for (const source of answer.sources) {
            const remaining = answer.sources.length - rows.length - 1;
            if (sourcesBlock([...rows, source.url], remaining).length > sourcesBudget) break;
            rows.push(source.url);
        }
        const omitted = answer.sources.length - rows.length;
        let sources = rows.length === 0 && omitted > 0 ? "" : sourcesBlock(rows, omitted);
        const answerBudget = this.#maxOutputCharacters - sources.length;
        const text =
            answer.answer.length <= answerBudget
                ? answer.answer
                : answerBudget > ANSWER_TRUNCATION_MARKER.length
                  ? `${answer.answer.slice(0, answerBudget - ANSWER_TRUNCATION_MARKER.length)}${ANSWER_TRUNCATION_MARKER}`
                  : "";

        /*
         * Titles are optional detail.  Add them one at a time only while the whole output still
         * fits, so a long title can never displace a URL the model needs.
         */
        for (let index = 0; index < rows.length; index += 1) {
            const source = answer.sources[index]!;
            const candidateRows = [...rows];
            candidateRows[index] = `${source.url} — ${source.title}`;
            const candidate = sourcesBlock(candidateRows, omitted);
            if (text.length + candidate.length <= this.#maxOutputCharacters) {
                rows[index] = candidateRows[index]!;
                sources = candidate;
            }
        }
        return `${text}${sources}`;
    }

    formatFetchForModel(result: FetchResult): string {
        if (!Value.Check(fetchResultSchema, result)) {
            throw new Error("Cannot format an invalid fetch result.");
        }
        if (result.url.length > this.#maxOutputCharacters) {
            throw new Error("Fetch result URL cannot fit within the model output limit.");
        }

        const title = result.title === undefined ? "" : `\n${result.title}`;
        const content = result.content.length === 0 ? "" : `\n${result.content}`;
        const marker = result.truncated ? FETCH_TRUNCATION_MARKER : "";
        const full = `${result.url}${title}${content}${marker}`;
        if (full.length <= this.#maxOutputCharacters) return full;

        /*
         * The URL is deliberately emitted first and never passed through a truncator.  Preserve
         * as much title/content as possible, reserve a marker for content that was cut, and keep
         * the complete output within the configured model budget.
         */
        let output = result.url;
        let remaining = this.#maxOutputCharacters - output.length;
        const hasContent = result.content.length > 0;
        const minimumAfterTitle = hasContent ? FETCH_TRUNCATION_MARKER.length + 2 : marker.length;
        if (
            title.length > 0 &&
            title.length <= remaining &&
            remaining - title.length >= minimumAfterTitle
        ) {
            output += title;
            remaining -= title.length;
        }

        if (hasContent) {
            const needsMarker = result.truncated || content.length > remaining;
            if (!needsMarker && content.length <= remaining) {
                output += content;
            } else if (remaining >= FETCH_TRUNCATION_MARKER.length + 2) {
                const contentCharacters = Math.min(
                    result.content.length,
                    remaining - FETCH_TRUNCATION_MARKER.length - 1,
                );
                if (contentCharacters > 0) {
                    output += `\n${result.content.slice(0, contentCharacters)}`;
                }
                output += FETCH_TRUNCATION_MARKER;
            } else if (remaining >= FETCH_TRUNCATION_MARKER.length) {
                output += FETCH_TRUNCATION_MARKER;
            }
        } else if (marker.length > 0 && remaining >= marker.length) {
            output += marker;
        } else if (title.length > 0 && remaining >= 2) {
            output += `\n${result.title!.slice(0, remaining - 1)}`;
        }
        return output;
    }
}

/** One vendor, one search. Each vendor searches in its own way, so each has its own function. */
async function vendorSearch(
    ctx: Context,
    search: VendorSearchContext,
    request: SearchProviderRequest,
): Promise<SearchAnswer> {
    switch (request.provider) {
        case "bedrock":
            return await bedrockWebSearch(ctx, search, request);
        case "claude":
            return await claudeWebSearch(ctx, search, request);
        case "codex":
            return await codexWebSearch(ctx, search, request);
        case "gemini":
            return await geminiWebSearch(ctx, search, request);
        case "grok":
            return await grokWebSearch(ctx, search, request);
        case "grok-x":
            return await grokXSearch(ctx, search, request);
    }
}

/** The cited-sources tail of a formatted answer, with a count of whatever did not fit. */
function sourcesBlock(rows: readonly string[], omitted: number): string {
    if (rows.length === 0 && omitted === 0) return "";
    const note =
        omitted === 0
            ? ""
            : `${rows.length === 0 ? "" : "\n"}[${omitted} more source${omitted === 1 ? "" : "s"} omitted.]`;
    return `${SOURCES_HEADING}${rows.join("\n")}${note}`;
}

function assertSearchAnswer(
    answer: unknown,
    request: SearchProviderRequest,
): asserts answer is SearchAnswer {
    if (!Value.Check(searchAnswerSchema, answer)) {
        throw new Error("The vendor search produced an invalid answer.");
    }
    if (answer.provider !== request.provider) {
        throw new Error("The vendor search answered as a different provider.");
    }
    if (answer.query !== request.query) {
        throw new Error("The vendor search returned an answer for a different query.");
    }
    if (!Number.isFinite(answer.durationMs)) {
        throw new Error("The vendor search reported an invalid search duration.");
    }
    const urls = new Set<string>();
    for (const source of answer.sources) {
        const canonical = canonicalSearchResultUrl(source.url);
        if (urls.has(canonical)) {
            throw new Error("The vendor search returned duplicate answer sources.");
        }
        urls.add(canonical);
    }
}

function normalizeFetchInput(input: FetchInput): FetchInput {
    if (!Value.Check(fetchInputSchema, input)) {
        throw new Error("Invalid fetch input.");
    }
    const url = normalizeFetchUrl(input.url);
    return {
        url,
        ...(input.maxCharacters === undefined ? {} : { maxCharacters: input.maxCharacters }),
    };
}

function normalizeFetchUrl(value: string): string {
    const trimmed = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error("Fetch URL is invalid.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Fetch URL must use http or https.");
    }
    const normalized = parsed.href;
    if (normalized.length > MAX_FETCH_URL_LENGTH) {
        throw new Error("Fetch URL is too long.");
    }
    return normalized;
}

function assertAgentId(agentId: string): void {
    if (!Value.Check(searchAgentIdSchema, agentId) || agentId.trim() !== agentId) {
        throw new Error("Search agent identity is invalid.");
    }
}

function canonicalSearchResultUrl(value: string): string {
    let normalized: string;
    try {
        normalized = normalizeFetchUrl(value);
    } catch {
        throw new Error("The vendor search returned an invalid source URL.");
    }
    if (normalized !== value) {
        throw new Error("The vendor search returned a non-canonical source URL.");
    }
    return normalized;
}
