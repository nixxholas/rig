import { Value } from "@sinclair/typebox/value";
import type { AgentModuleScope, AnyAgentTool } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MAX_FETCH_CONTENT_CHARACTERS,
    MAX_FETCH_URL_LENGTH,
    MAX_SEARCH_QUERY_LENGTH,
    fetchResultSchema,
    searchPageSchema,
    searchProviderRequestSchema,
    type FetchResult,
    type SearchPage,
    type SearchProviderRequest,
    type SearchQuery,
} from "../../sources/search/Search.js";
import type { SearchBackend } from "../../sources/search/SearchBackend.js";
import { SearchModule } from "../../sources/search/SearchModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("happy-agent-modules-search-edge");
const AGENT_ID = "agent-edge";

function page(query = "rig"): SearchPage {
    return {
        query,
        results: [
            {
                id: "result-1",
                title: "Rig",
                url: "https://example.test/rig",
            },
        ],
    };
}

class EdgeBackend implements SearchBackend {
    readonly #searchCalls: Array<{
        readonly ctx: Context;
        readonly agentId: string;
        readonly query: SearchQuery;
    }> = [];
    readonly #providerCalls: Array<{
        readonly ctx: Context;
        readonly agentId: string;
        readonly request: SearchProviderRequest;
    }> = [];
    readonly #fetchCalls: Array<{
        readonly ctx: Context;
        readonly agentId: string;
        readonly input: { readonly url: string; readonly maxCharacters?: number };
    }> = [];

    #searchPage: SearchPage = page();
    #fetchResult: FetchResult = {
        url: "https://example.test/rig",
        title: "Rig",
        content: "content",
        contentType: "text/plain",
        truncated: false,
    };
    #searchError: Error | undefined;
    #fetchError: Error | undefined;
    #providerError: Error | undefined;

    get searchCalls() {
        return this.#searchCalls;
    }

    get providerCalls() {
        return this.#providerCalls;
    }

    get fetchCalls() {
        return this.#fetchCalls;
    }

    get searchPage() {
        return this.#searchPage;
    }

    set searchPage(value: SearchPage) {
        this.#searchPage = value;
    }

    get fetchResult() {
        return this.#fetchResult;
    }

    set fetchResult(value: FetchResult) {
        this.#fetchResult = value;
    }

    get searchError() {
        return this.#searchError;
    }

    set searchError(value: Error | undefined) {
        this.#searchError = value;
    }

    get fetchError() {
        return this.#fetchError;
    }

    set fetchError(value: Error | undefined) {
        this.#fetchError = value;
    }

    get providerError() {
        return this.#providerError;
    }

    set providerError(value: Error | undefined) {
        this.#providerError = value;
    }

    async search(callCtx: Context, agentId: string, query: SearchQuery): Promise<SearchPage> {
        this.#searchCalls.push({ ctx: callCtx, agentId, query });
        if (this.#searchError !== undefined) throw this.#searchError;
        return this.#searchPage;
    }

    async searchProvider(
        callCtx: Context,
        agentId: string,
        request: SearchProviderRequest,
    ): Promise<SearchPage> {
        this.#providerCalls.push({ ctx: callCtx, agentId, request });
        if (this.#providerError !== undefined) throw this.#providerError;
        return { ...this.#searchPage, query: request.query };
    }

    async fetch(
        callCtx: Context,
        agentId: string,
        input: { readonly url: string; readonly maxCharacters?: number },
    ): Promise<FetchResult> {
        this.#fetchCalls.push({ ctx: callCtx, agentId, input });
        if (this.#fetchError !== undefined) throw this.#fetchError;
        return this.#fetchResult;
    }
}

function search(
    backend: SearchBackend = new EdgeBackend(),
    overrides: Partial<{
        maxResults: number;
        maxCharacters: number;
        maxOutputCharacters: number;
    }> = {},
): SearchModule {
    return new SearchModule({ backend, ...overrides });
}

function toolsFor(
    searchModule: SearchModule,
    agentId = AGENT_ID,
): Promise<readonly AnyAgentTool[]> {
    return resolveModuleHooks(ctx, searchModule).then(async (hooks) => {
        expect(hooks.tools).toBeDefined();
        return await hooks.tools!(ctx, {
            agent: { id: agentId },
        } as AgentModuleScope);
    });
}

function byName(tools: readonly AnyAgentTool[]): Map<string, AnyAgentTool> {
    return new Map(tools.map((tool) => [tool.name, tool]));
}

describe("SearchModule edge contracts", () => {
    it("rejects malformed module options and host backend shapes", () => {
        const backend = new EdgeBackend();

        expect(
            () =>
                new SearchModule({
                    backend,
                    maxResults: 0,
                }),
        ).toThrow("options are invalid");
        expect(
            () =>
                new SearchModule({
                    backend,
                    maxOutputCharacters: 255,
                }),
        ).toThrow("options are invalid");
        expect(
            () =>
                new SearchModule({
                    backend,
                    unexpected: true,
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new SearchModule({
                    backend: {
                        ...backend,
                        unexpected: true,
                    } as never,
                }),
        ).toThrow("options are invalid");
        expect(
            () =>
                new SearchModule({
                    backend: {
                        search: backend.search,
                        fetch: undefined,
                    } as never,
                }),
        ).toThrow("options are invalid");
    });

    it("bounds and validates public identities and input objects before calling the host", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);

        await expect(searchModule.search(ctx, "", { query: "rig" })).rejects.toThrow(
            "agent identity",
        );
        await expect(searchModule.search(ctx, " agent-edge", { query: "rig" })).rejects.toThrow(
            "agent identity",
        );
        await expect(searchModule.search(ctx, AGENT_ID, { query: " ".repeat(3) })).rejects.toThrow(
            "empty",
        );
        await expect(
            searchModule.search(ctx, AGENT_ID, {
                query: "x".repeat(MAX_SEARCH_QUERY_LENGTH + 1),
            }),
        ).rejects.toThrow("Invalid search query");
        await expect(
            searchModule.search(ctx, AGENT_ID, {
                query: "rig",
                unexpected: true,
            } as never),
        ).rejects.toThrow("Invalid search query");
        await expect(
            searchModule.providerSearch(ctx, AGENT_ID, {
                provider: "codex",
                query: "rig",
                unexpected: true,
            } as never),
        ).rejects.toThrow("Invalid provider search request");
        await expect(
            searchModule.fetch(ctx, AGENT_ID, {
                url: "https://example.test/rig",
                unexpected: true,
            } as never),
        ).rejects.toThrow("Invalid fetch input");
        expect(backend.searchCalls).toHaveLength(0);
        expect(backend.providerCalls).toHaveLength(0);
        expect(backend.fetchCalls).toHaveLength(0);
    });

    it("normalizes routed query fields and copies filter arrays before host execution", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);
        const allowedDomains = ["example.test"];
        const blockedDomains: string[] = [];
        const request: SearchProviderRequest = {
            provider: "grok-x",
            query: "  current rig  ",
            providerId: "account-one",
            allowedDomains,
            blockedDomains,
            latest: true,
            limit: 4,
            cursor: 7,
        };

        const result = await searchModule.providerSearch(ctx, AGENT_ID, request);
        expect(result.query).toBe("current rig");
        expect(backend.providerCalls).toHaveLength(1);
        expect(backend.providerCalls[0]).toMatchObject({
            ctx,
            agentId: AGENT_ID,
            request: {
                provider: "grok-x",
                query: "current rig",
                providerId: "account-one",
                allowedDomains: ["example.test"],
                blockedDomains: [],
                latest: true,
                limit: 4,
                cursor: 7,
            },
        });
        expect(backend.providerCalls[0]!.request.allowedDomains).not.toBe(allowedDomains);
        expect(backend.providerCalls[0]!.request.blockedDomains).not.toBe(blockedDomains);

        allowedDomains.push("mutated.test");
        blockedDomains.push("also-mutated.test");
        expect(backend.providerCalls[0]!.request.allowedDomains).toEqual(["example.test"]);
        expect(backend.providerCalls[0]!.request.blockedDomains).toEqual([]);
    });

    it("rejects conflicting routed domain filters and malformed routed provider values", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);

        await expect(
            searchModule.providerSearch(ctx, AGENT_ID, {
                provider: "claude",
                query: "rig",
                allowedDomains: ["example.test"],
                blockedDomains: ["blocked.test"],
            }),
        ).rejects.toThrow("allow and block");
        await expect(
            searchModule.providerSearch(ctx, AGENT_ID, {
                provider: "codex",
                query: "rig",
                providerId: "   ",
            }),
        ).rejects.toThrow("provider");
        await expect(
            searchModule.providerSearch(ctx, AGENT_ID, {
                provider: "codex",
                query: "rig",
                allowedDomains: [""],
            }),
        ).rejects.toThrow("Invalid provider search request");
        await expect(
            searchModule.providerSearch(ctx, AGENT_ID, {
                provider: "codex",
                query: "rig",
                allowedDomains: ["x".repeat(254)],
            }),
        ).rejects.toThrow("Invalid provider search request");
        expect(backend.providerCalls).toHaveLength(0);
    });

    it("supports the generic backend fallback when no routed search method exists", async () => {
        const calls: SearchQuery[] = [];
        const fallbackBackend: SearchBackend = {
            search: async (_ctx, _agentId, query) => {
                calls.push(query);
                return {
                    query: query.query,
                    results: [],
                };
            },
            fetch: async (_ctx, _agentId, input) => ({
                url: input.url,
                content: "",
                truncated: false,
            }),
        };
        const searchModule = search(fallbackBackend);

        await expect(
            searchModule.providerSearch(ctx, AGENT_ID, {
                provider: "gemini",
                query: "  docs  ",
                providerId: "gemini-account",
                allowedDomains: ["docs.example.test"],
                latest: true,
                limit: 3,
                cursor: 9,
            }),
        ).resolves.toEqual({
            query: "docs",
            results: [],
        });
        expect(calls).toEqual([{ query: "docs", limit: 3, cursor: 9 }]);
    });

    it("validates host page scores, identity whitespace, and cursor boundaries", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);

        for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            backend.searchPage = {
                query: "rig",
                results: [
                    {
                        ...page().results[0]!,
                        score,
                    },
                ],
            };
            await expect(searchModule.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
                "invalid result page",
            );
        }

        backend.searchPage = {
            query: "rig",
            results: [
                {
                    ...page().results[0]!,
                    id: " ",
                },
            ],
        };
        await expect(searchModule.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
            "invalid result identity",
        );

        backend.searchPage = {
            query: "rig",
            results: [
                {
                    ...page().results[0]!,
                    url: "https://example.test/rig",
                },
            ],
            nextCursor: 1_000_000,
        };
        await expect(
            searchModule.search(ctx, AGENT_ID, { query: "rig", cursor: 1_000_000 }),
        ).rejects.toThrow("cursor");
    });

    it("bounds fetch requests and rejects host schema lies while preserving metadata on truncation", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend, {
            maxCharacters: 2_000,
        });
        backend.fetchResult = {
            url: "https://example.test/rig",
            title: "Title",
            content: "x".repeat(5_000),
            contentType: "text/plain",
            truncated: false,
        };

        const fetched = await searchModule.fetch(ctx, AGENT_ID, {
            url: " HTTPS://EXAMPLE.TEST/rig ",
            maxCharacters: 1_000,
        });
        expect(backend.fetchCalls).toEqual([
            {
                ctx,
                agentId: AGENT_ID,
                input: {
                    url: "https://example.test/rig",
                    maxCharacters: 1_000,
                },
            },
        ]);
        expect(fetched).toEqual({
            url: "https://example.test/rig",
            title: "Title",
            content: "x".repeat(1_000),
            contentType: "text/plain",
            truncated: true,
        });
        expect(Value.Check(fetchResultSchema, fetched)).toBe(true);

        backend.fetchResult = {
            url: "https://example.test/rig",
            content: "x".repeat(MAX_FETCH_CONTENT_CHARACTERS + 1),
            truncated: false,
        };
        await expect(
            searchModule.fetch(ctx, AGENT_ID, { url: "https://example.test/rig" }),
        ).rejects.toThrow("invalid fetch result");
        backend.fetchResult = {
            url: "https://example.test/rig",
            content: "content",
            contentType: 42,
            truncated: false,
        } as never;
        await expect(
            searchModule.fetch(ctx, AGENT_ID, { url: "https://example.test/rig" }),
        ).rejects.toThrow("invalid fetch result");
    });

    it("propagates host failures and never caches independent search or fetch calls", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);
        backend.searchError = new Error("search timeout");
        await expect(searchModule.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
            "search timeout",
        );
        backend.searchError = undefined;

        backend.fetchError = new Error("fetch aborted");
        await expect(
            searchModule.fetch(ctx, AGENT_ID, { url: "https://example.test/rig" }),
        ).rejects.toThrow("fetch aborted");
        backend.fetchError = undefined;

        await searchModule.search(ctx, AGENT_ID, { query: "rig" });
        await searchModule.search(ctx, AGENT_ID, { query: "other" }).catch(() => undefined);
        await searchModule.fetch(ctx, AGENT_ID, { url: "https://example.test/rig" });
        await searchModule.fetch(ctx, AGENT_ID, { url: "https://example.test/rig" });
        expect(backend.searchCalls).toHaveLength(3);
        expect(backend.fetchCalls).toHaveLength(3);
    });

    it("keeps concurrent calls isolated by agent and query", async () => {
        const calls: Array<{
            readonly agentId: string;
            readonly query: SearchQuery;
            readonly resolve: (page: SearchPage) => void;
        }> = [];
        const backend: SearchBackend = {
            search: async (_ctx, agentId, query) =>
                await new Promise<SearchPage>((resolve) => {
                    calls.push({ agentId, query, resolve });
                }),
            fetch: async (_ctx, _agentId, input) => ({
                url: input.url,
                content: input.url,
                truncated: false,
            }),
        };
        const searchModule = search(backend);
        const first = searchModule.search(ctx, "agent-a", { query: "first" });
        const second = searchModule.search(ctx, "agent-b", { query: "second" });
        await Promise.resolve();
        expect(calls.map(({ agentId, query }) => ({ agentId, query }))).toEqual([
            { agentId: "agent-a", query: { query: "first", limit: 10 } },
            { agentId: "agent-b", query: { query: "second", limit: 10 } },
        ]);

        calls[1]!.resolve({
            query: "second",
            results: [],
        });
        calls[0]!.resolve({
            query: "first",
            results: [],
        });
        await expect(first).resolves.toEqual({ query: "first", results: [] });
        await expect(second).resolves.toEqual({ query: "second", results: [] });
    });

    it("keeps model output bounded and preserves every actionable URL", () => {
        const searchModule = search(new EdgeBackend(), {
            maxOutputCharacters: 256,
        });
        const urls = ["https://example.test/a", "https://example.test/b", "https://example.test/c"];
        const output = searchModule.formatSearchForModel({
            query: "rig",
            results: urls.map((url, index) => ({
                id: `id-${index}`,
                title: "a title ".repeat(250),
                url,
            })),
            nextCursor: 3,
        });
        expect(output.length).toBeLessThanOrEqual(256);
        for (const url of urls) expect(output).toContain(url);
        expect(output).toContain("next_cursor=3");

        expect(
            searchModule.formatSearchForModel({
                query: "rig",
                results: [],
            }),
        ).toBe("No search results.");
        expect(() =>
            searchModule.formatSearchForModel({
                query: "rig",
                results: [{ title: "bad", url: "file:///tmp/bad" }],
            }),
        ).toThrow("invalid result URL");
        expect(() =>
            searchModule.formatFetchForModel({
                url: "https://example.test/rig",
                title: "title",
                content: "x".repeat(2_000),
                truncated: true,
            }),
        ).not.toThrow();
        expect(
            searchModule.formatFetchForModel({
                url: "https://example.test/rig",
                title: "title",
                content: "x".repeat(2_000),
                truncated: true,
            }).length,
        ).toBeLessThanOrEqual(256);
    });

    it("rejects a formatter continuation that cannot represent progress", () => {
        const searchModule = search(new EdgeBackend());
        expect(() =>
            searchModule.formatSearchForModel({
                query: "rig",
                results: [],
                nextCursor: 1,
            }),
        ).toThrow("result");
    });

    it("keeps a normalized URL at the documented length bound after surrounding whitespace", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);
        const prefix = "https://example.test/";
        const url = `${prefix}${"x".repeat(MAX_FETCH_URL_LENGTH - prefix.length)}`;
        backend.fetchResult = {
            url,
            content: "ok",
            truncated: false,
        };

        await expect(
            searchModule.fetch(ctx, AGENT_ID, {
                url: `  ${url}  `,
            }),
        ).resolves.toMatchObject({ url, content: "ok" });
    });

    it("does not expose private or credential-bearing destinations through web_fetch", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);
        for (const url of [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://169.254.169.254/",
            "http://user:password@example.test/",
        ]) {
            backend.fetchResult = {
                url,
                content: "private",
                truncated: false,
            };
            await expect(
                searchModule.fetch(ctx, AGENT_ID, { url }),
                `unsafe destination ${url}`,
            ).rejects.toThrow();
        }
        expect(backend.fetchCalls).toHaveLength(0);
    });

    it("does not pass binary bodies to the text-only fetch result", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);
        backend.fetchResult = {
            url: "https://example.test/rig",
            content: "\u0000\u0001\u0002binary",
            contentType: "application/octet-stream",
            truncated: false,
        };

        await expect(
            searchModule.fetch(ctx, AGENT_ID, { url: "https://example.test/rig" }),
        ).rejects.toThrow();
    });

    it("exposes every vendor tool with explicit Auto network permissions and routed fields", async () => {
        const backend = new EdgeBackend();
        const searchModule = search(backend);
        const tools = await toolsFor(searchModule);
        expect(tools.map((tool) => tool.name)).toEqual([
            "web_fetch",
            "gemini_web_search",
            "claude_web_search",
            "codex_web_search",
            "bedrock_web_search",
            "grok_web_search",
            "grok_x_search",
        ]);
        expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
        for (const tool of tools) {
            expect(tool.durable).toBe(false);
            expect(tool.transactional).not.toBe(true);
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(tool.shouldReviewInAutoMode({}, ctx)).toBe(true);
            expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
            expect(tool.description).toBeTruthy();
            expect(tool.describeAutoPermissionAction?.({ query: "rig" } as never, ctx)).toContain(
                "external",
            );
            expect(tool.returnType).toBeDefined();
        }

        const names = byName(tools);
        const routedInputs: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
            ["gemini_web_search", { query: "rig", allowed_domains: ["example.test"] }],
            ["claude_web_search", { query: "rig", blocked_domains: ["blocked.test"] }],
            ["codex_web_search", { query: "rig", domains: ["example.test"] }],
            ["bedrock_web_search", { query: "rig", provider_id: "bedrock-account" }],
            ["grok_web_search", { query: "rig", include_domains: ["example.test"] }],
            ["grok_x_search", { query: "rig", latest: true }],
        ];
        for (const [name, input] of routedInputs) {
            await names.get(name)!.execute(ctx, input, undefined as never);
        }
        expect(backend.providerCalls.map(({ request }) => request)).toEqual([
            {
                provider: "gemini",
                query: "rig",
                allowedDomains: ["example.test"],
                limit: 10,
            },
            {
                provider: "claude",
                query: "rig",
                blockedDomains: ["blocked.test"],
                limit: 10,
            },
            {
                provider: "codex",
                query: "rig",
                allowedDomains: ["example.test"],
                limit: 10,
            },
            {
                provider: "bedrock",
                query: "rig",
                providerId: "bedrock-account",
                limit: 10,
            },
            {
                provider: "grok",
                query: "rig",
                allowedDomains: ["example.test"],
                limit: 10,
            },
            {
                provider: "grok-x",
                query: "rig",
                latest: true,
                limit: 10,
            },
        ]);
    });

    it("lets a model submit a vendor search continuation cursor", async () => {
        const searchModule = search(new EdgeBackend());
        const tools = await toolsFor(searchModule);
        for (const tool of tools.filter((candidate) => candidate.name !== "web_fetch")) {
            const parameters = tool.parameters as {
                readonly properties?: Record<string, unknown>;
            };
            expect(parameters.properties).toHaveProperty("cursor");
            expect(
                Value.Check(tool.parameters!, {
                    query: "rig",
                    cursor: 4,
                }),
            ).toBe(true);
        }
    });

    it("lets every vendor search tool render bounded structured pages", async () => {
        const searchModule = search(new EdgeBackend(), {
            maxOutputCharacters: 256,
        });
        const tools = await toolsFor(searchModule);
        const routed = tools.filter((tool) => tool.name !== "web_fetch");
        const result = {
            query: "rig",
            results: [
                {
                    title: "Rig",
                    url: "https://example.test/rig",
                },
            ],
        };
        for (const tool of routed) {
            expect(Value.Check(tool.returnType, result)).toBe(true);
            const blocks = tool.toLLM(result);
            expect(blocks).toHaveLength(1);
            expect(blocks[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("https://example.test/rig"),
            });
        }
        const fetch = tools.find((tool) => tool.name === "web_fetch")!;
        const fetchResult: FetchResult = {
            url: "https://example.test/rig",
            content: "content",
            truncated: false,
        };
        expect(Value.Check(fetch.returnType, fetchResult)).toBe(true);
        expect(fetch.toLLM(fetchResult)[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("https://example.test/rig"),
        });
    });

    it("allows only legal provider request shapes and result pages", () => {
        expect(
            Value.Check(searchProviderRequestSchema, {
                provider: "codex",
                query: "rig",
                providerId: "account",
                limit: 1,
                cursor: 0,
            }),
        ).toBe(true);
        expect(
            Value.Check(searchProviderRequestSchema, {
                provider: "not-a-provider",
                query: "rig",
            }),
        ).toBe(false);
        expect(
            Value.Check(searchPageSchema, {
                query: "rig",
                results: [
                    {
                        title: "Rig",
                        url: "https://example.test/rig",
                    },
                ],
            }),
        ).toBe(true);
        expect(
            Value.Check(searchPageSchema, {
                query: "rig",
                results: [
                    {
                        title: "Rig",
                        url: "https://example.test/rig",
                        unknown: true,
                    },
                ],
            }),
        ).toBe(false);
    });
});
