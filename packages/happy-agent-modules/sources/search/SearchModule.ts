import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
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
    MAX_SEARCH_CURSOR,
    MAX_SEARCH_RESULT_URL_LENGTH,
    MAX_SEARCH_RESULTS_PER_PAGE,
    searchAgentIdSchema,
    searchPageSchema,
    searchProviderRequestSchema,
    searchQuerySchema,
    type FetchInput,
    type FetchResult,
    type SearchPage,
    type SearchProviderRequest,
    type SearchQuery,
} from "./Search.js";
import { searchBackendSchema, type SearchBackend } from "./SearchBackend.js";
import { bedrockWebSearchTool } from "./tools/bedrock_web_search.js";
import { claudeWebSearchTool } from "./tools/claude_web_search.js";
import { codexWebSearchTool } from "./tools/codex_web_search.js";
import { geminiWebSearchTool } from "./tools/gemini_web_search.js";
import { grokWebSearchTool } from "./tools/grok_web_search.js";
import { grokXSearchTool } from "./tools/grok_x_search.js";
import { webFetchTool } from "./tools/web_fetch.js";

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_CHARACTERS = 40_000;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 12_000;
const MIN_MAX_OUTPUT_CHARACTERS = 256;
const MAX_MAX_OUTPUT_CHARACTERS = 100_000;
const NEXT_CURSOR_OUTPUT_PREFIX = "\nnext_cursor=";
const NO_RESULTS_OUTPUT = "No search results.";
const FETCH_TRUNCATION_MARKER = "\n[Content truncated.]";

const searchModuleOptionsSchema = Type.Object(
    {
        backend: searchBackendSchema,
        maxResults: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_SEARCH_RESULTS_PER_PAGE,
            }),
        ),
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

/** Provider-neutral search and fetch over a host-owned boundary. */
export class SearchModule implements AgentModule {
    readonly name = "search";
    readonly #backend: SearchBackend;
    readonly #maxResults: number;
    readonly #maxCharacters: number;
    readonly #maxOutputCharacters: number;

    constructor(options: SearchModuleOptions) {
        const checkedOptions = runtimeOptions(options);
        if (!Value.Check(searchModuleOptionsSchema, checkedOptions)) {
            throw new Error("Search module options are invalid.");
        }
        this.#backend = options.backend;
        this.#maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
        this.#maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
    }

    async search(ctx: Context, agentId: string, query: SearchQuery): Promise<SearchPage> {
        assertAgentId(agentId);
        const normalizedQuery = normalizeQuery(query);
        const limit = Math.min(
            normalizedQuery.limit ?? this.#maxResults,
            this.#maxResults,
            this.#maxModelVisibleResults(),
        );
        const normalized: SearchQuery = {
            query: normalizedQuery.query,
            limit,
            ...(normalizedQuery.cursor === undefined ? {} : { cursor: normalizedQuery.cursor }),
        };
        const page = await this.#backend.search(ctx, agentId, normalized);
        assertSearchPage(page, normalized);
        /*
         * The formatter is deliberately part of the module boundary.  A backend page whose
         * identities cannot all be shown within the configured model budget is rejected rather
         * than silently advancing its cursor past records the model cannot name.
         */
        this.formatSearchForModel(page);
        return page;
    }

    async providerSearch(
        ctx: Context,
        agentId: string,
        request: SearchProviderRequest,
    ): Promise<SearchPage> {
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
        const limit = Math.min(
            request.limit ?? this.#maxResults,
            this.#maxResults,
            this.#maxModelVisibleResults(),
        );
        const normalized: SearchProviderRequest = {
            provider: request.provider,
            query,
            limit,
            ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            ...(request.allowedDomains === undefined
                ? {}
                : { allowedDomains: [...request.allowedDomains] }),
            ...(request.blockedDomains === undefined
                ? {}
                : { blockedDomains: [...request.blockedDomains] }),
            ...(request.latest === undefined ? {} : { latest: request.latest }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        };
        const page =
            this.#backend.searchProvider === undefined
                ? await this.#backend.search(ctx, agentId, {
                      query: normalized.query,
                      limit,
                      ...(normalized.cursor === undefined ? {} : { cursor: normalized.cursor }),
                  })
                : await this.#backend.searchProvider(ctx, agentId, normalized);
        assertSearchPage(page, normalized);
        this.formatSearchForModel(page);
        return page;
    }

    async fetch(ctx: Context, agentId: string, input: FetchInput): Promise<FetchResult> {
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
        const result = await this.#backend.fetch(ctx, agentId, normalized);
        if (!Value.Check(fetchResultSchema, result)) {
            throw new Error("Search backend returned an invalid fetch result.");
        }
        if (result.url !== normalized.url) {
            throw new Error("Search backend returned content for a different normalized URL.");
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

    formatSearchForModel(page: SearchPage): string {
        if (!Value.Check(searchPageSchema, page)) {
            throw new Error("Cannot format an invalid search result page.");
        }
        assertUniqueResultIdentities(page);

        const continuation =
            page.nextCursor !== undefined ? `${NEXT_CURSOR_OUTPUT_PREFIX}${page.nextCursor}` : "";

        /*
         * URL is the action identity.  Start with URL-only rows so every returned record remains
         * actionable under the output bound, then opportunistically add titles when they fit.
         * Never truncate or remove a URL to make room for optional metadata.
         */
        const rows = page.results.map((result) => result.url);
        let output = rows.length === 0 ? NO_RESULTS_OUTPUT : `${rows.join("\n")}${continuation}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Search result URLs cannot fit within the model output limit.");
        }
        for (let index = 0; index < page.results.length; index += 1) {
            const result = page.results[index]!;
            const candidateRows = [...rows];
            candidateRows[index] = `${result.url} — ${result.title}`;
            const candidate = `${candidateRows.join("\n")}${continuation}`;
            if (candidate.length <= this.#maxOutputCharacters) {
                rows[index] = candidateRows[index]!;
                output = candidate;
            }
        }
        return output;
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

    #maxModelVisibleResults(): number {
        /*
         * Reserve enough room for the longest legal continuation cursor and one complete URL per
         * result.  This bound is computed before the host call, so a backend cannot advance past
         * records that the model cannot name.
         */
        const continuationBudget =
            NEXT_CURSOR_OUTPUT_PREFIX.length + String(MAX_SEARCH_CURSOR).length;
        const rowBudget = MAX_SEARCH_RESULT_URL_LENGTH + 1;
        const available = this.#maxOutputCharacters - continuationBudget;
        const byOutput = Math.floor((available + 1) / rowBudget);
        return Math.max(1, Math.min(MAX_SEARCH_RESULTS_PER_PAGE, byOutput));
    }
}

function runtimeOptions(options: SearchModuleOptions): SearchModuleOptions {
    /*
     * TypeBox's closed object check inspects enumerable properties.  Host adapters are often
     * class instances with prototype methods, so materialize only the class surface while
     * retaining enumerable extras for the closed-schema rejection.
     */
    return {
        ...options,
        backend: {
            ...options.backend,
            search: options.backend.search,
            fetch: options.backend.fetch,
            ...(options.backend.searchProvider === undefined
                ? {}
                : { searchProvider: options.backend.searchProvider }),
        },
    };
}

function normalizeQuery(query: SearchQuery): SearchQuery {
    if (!Value.Check(searchQuerySchema, query)) {
        throw new Error("Invalid search query.");
    }
    const text = query.query.trim();
    if (text.length === 0) throw new Error("Search query cannot be empty.");
    return {
        query: text,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    };
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

function assertSearchPage(page: unknown, request: SearchQuery): asserts page is SearchPage {
    if (!Value.Check(searchPageSchema, page)) {
        throw new Error("Search backend returned an invalid result page.");
    }
    if (page.query !== request.query) {
        throw new Error("Search backend returned a page for a different query.");
    }
    if (page.results.length > (request.limit ?? MAX_SEARCH_RESULTS_PER_PAGE)) {
        throw new Error("Search backend returned more results than requested.");
    }
    assertUniqueResultIdentities(page);
    for (const result of page.results) {
        if (result.id !== undefined && result.id.trim() !== result.id) {
            throw new Error("Search backend returned an invalid result identity.");
        }
        if (result.score !== undefined && !Number.isFinite(result.score)) {
            throw new Error("Search backend returned an invalid result score.");
        }
    }
    if (page.nextCursor !== undefined) {
        if (page.results.length === 0) {
            throw new Error("Search backend advanced the cursor without returning a result.");
        }
        assertCursorAdvances(request.cursor ?? 0, page.nextCursor, page.results.length);
    }
}

function assertUniqueResultIdentities(page: SearchPage): void {
    const urls = new Set<string>();
    const ids = new Set<string>();
    for (const result of page.results) {
        const canonicalUrl = canonicalSearchResultUrl(result.url);
        if (urls.has(canonicalUrl)) {
            throw new Error("Search backend returned duplicate result identities.");
        }
        urls.add(canonicalUrl);
        if (result.id !== undefined) {
            if (ids.has(result.id)) {
                throw new Error("Search backend returned duplicate result identities.");
            }
            ids.add(result.id);
        }
    }
}

function canonicalSearchResultUrl(value: string): string {
    let normalized: string;
    try {
        normalized = normalizeFetchUrl(value);
    } catch {
        throw new Error("Search backend returned an invalid result URL.");
    }
    if (normalized !== value) {
        throw new Error("Search backend returned a non-canonical result URL.");
    }
    return normalized;
}

function assertCursorAdvances(requested: number, next: number, visibleCount: number): void {
    if (next <= requested) {
        throw new Error("Search backend returned a non-advancing cursor.");
    }
    const expected = requested + visibleCount;
    if (next !== expected) {
        throw new Error(
            "Search backend returned a cursor that does not match the returned result count.",
        );
    }
}
