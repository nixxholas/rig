import { testContext } from "./testContext.js";

import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeOAuthCredential } from "@/vendors/claude/ClaudeOAuthCredential.js";
import { ClaudeApiKeyCredential } from "@/vendors/claude/ClaudeApiKeyCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import type { ClaudeCredential } from "@/vendors/VendorCredential.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { claude_server_tools } from "@/vendors/claude/tools/index.js";
import { grok_server_tools } from "@/vendors/grok/tools/index.js";
import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import { OPENAI_RESPONSES_CAPABILITIES } from "@/protocol/responses/ResponsesCapabilities.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

/**
 * Live coverage for provider-owned server tool calls and their result events.
 *
 * Grok and Claude Code search on their backends; OpenRouter is exercised on an Anthropic model
 * through the Responses transport when a key is present. Each test only runs when its credential
 * is available under RIG_LIVE_TEST=1.
 */
const LIVE = process.env.RIG_LIVE_TEST === "1";

async function resolveGrokCredential() {
    return (await GrokSessionCredential.tryLoad()) ?? (await GrokApiKeyCredential.tryLoad());
}

async function resolveClaudeCredential(): Promise<ClaudeCredential | null> {
    return (
        (await ClaudeCodeCredential.tryLoad({ env: process.env })) ??
        (await ClaudeOAuthCredential.tryLoad({ env: process.env })) ??
        (await ClaudeAuthTokenCredential.tryLoad({ env: process.env })) ??
        (await ClaudeApiKeyCredential.tryLoad({ env: process.env }))
    );
}

function serverStarts(events: readonly SessionEvent[]) {
    return events.filter(
        (event): event is Extract<SessionEvent, { type: "toolcall_start" }> & { server: true } =>
            event.type === "toolcall_start" && event.server === true,
    );
}

function serverResults(events: readonly SessionEvent[]) {
    return events.filter(
        (event): event is Extract<SessionEvent, { type: "toolcall_result_end" }> =>
            event.type === "toolcall_result_end",
    );
}

describe.skipIf(!LIVE)("Server tool result live coverage", () => {
    it(
        "Grok web search emits server tool calls and source results",
        { timeout: 180_000 },
        async () => {
            const credential = await resolveGrokCredential();
            if (credential === null) {
                expect.fail("RIG_LIVE_TEST=1 is set but no Grok credentials were found");
            }

            const provider = new GrokProvider({ credential });
            const session = await provider.session(`grok-web-search-result-live-${Date.now()}`, {
                instructions: "You are a concise assistant.",
                tools: grok_server_tools.filter((tool) => tool.name === "web_search"),
            });
            const events = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text" as const,
                                        text: "<user_query>Search the web for the current Node.js LTS version and cite one official URL.</user_query>",
                                    },
                                ],
                            },
                        ],
                    },
                    model: "grok-4.5",
                    effort: "low",
                }),
            );

            const searches = serverStarts(events);
            expect(searches.length).toBeGreaterThan(0);
            expect(searches.every((event) => event.name === "web_search")).toBe(true);
            const ends = events.filter(
                (event): event is Extract<SessionEvent, { type: "toolcall_end" }> =>
                    event.type === "toolcall_end" &&
                    searches.some((start) => start.callId === event.callId),
            );
            expect(ends.length).toBeGreaterThan(0);
            // Prefer structured result events when sources are present. Some live responses only
            // put the query on the call and leave citations in the prose; both are valid as long
            // as the server call is reported and the turn finishes.
            const results = serverResults(events);
            if (results.length > 0) {
                expect(
                    results.some((event) => {
                        const result = event.content
                            .filter((block) => block.type === "text")
                            .map((block) => block.text)
                            .join("");
                        try {
                            const parsed: unknown = JSON.parse(result);
                            return Array.isArray(parsed) && parsed.length > 0;
                        } catch {
                            return result.length > 0;
                        }
                    }),
                ).toBe(true);
            } else {
                expect(
                    ends.some((event) => {
                        try {
                            const action = JSON.parse(event.arguments) as { type?: string };
                            return action.type === "search";
                        } catch {
                            return false;
                        }
                    }),
                ).toBe(true);
            }
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(textFromSessionEvents(events).length).toBeGreaterThan(0);
        },
    );

    it(
        "Claude Code WebSearch runs as a server tool without executor work",
        { timeout: 180_000 },
        async () => {
            const credential = await resolveClaudeCredential();
            if (credential === null) {
                expect.fail(
                    "RIG_LIVE_TEST=1 is set but no Claude credentials were found (Claude Code, OAuth, auth token, or API key)",
                );
            }

            const session = new ClaudeSession(`claude-websearch-result-live-${Date.now()}`, {
                instructions: "You are a concise assistant. Always use WebSearch for this request.",
                credential,
                model: "sonnet[1m]",
                tools: claude_server_tools,
            });
            let events: SessionEvent[];
            try {
                events = await collectSessionEvents(
                    session.run(testContext, {
                        context: {
                            instructions: "",
                            messages: [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            type: "text" as const,
                                            text: "Use WebSearch to find the current Node.js LTS version and reply with one official URL.",
                                        },
                                    ],
                                },
                            ],
                        },
                    }),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // A live Claude Code account can be rate-limited independently of Rig. Report the
                // limit clearly rather than treating it as a regression in the event mapping.
                if (/weekly limit|rate limit|usage limit/i.test(message)) {
                    console.warn(`Skipping Claude Code live search: ${message}`);
                    return;
                }
                throw error;
            }

            const searches = serverStarts(events);
            expect(searches.length).toBeGreaterThan(0);
            expect(searches.every((event) => event.name === "WebSearch")).toBe(true);
            // Claude Code may answer the built-in out of band without streaming a result block.
            // When result events are present they must pair to a server call; when absent the
            // turn must still finish normally without client tool work.
            const resultCallIds = new Set(serverResults(events).map((event) => event.callId));
            for (const callId of resultCallIds) {
                expect(searches.some((event) => event.callId === callId)).toBe(true);
            }
            expect(
                events.filter((event) => event.type === "toolcall_start" && event.server !== true),
            ).toEqual([]);
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(textFromSessionEvents(events).length).toBeGreaterThan(0);
        },
    );

    it(
        "OpenRouter Anthropic can run a Responses turn (search when the model supports it)",
        { timeout: 180_000 },
        async () => {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (apiKey === undefined) {
                expect.fail("RIG_LIVE_TEST=1 is set but OPENROUTER_API_KEY is missing");
            }

            const provider = new ResponsesProvider({
                apiKey,
                endpoint: "https://openrouter.ai/api/v1",
                model: "anthropic/claude-sonnet-4.5",
                nativeCompaction: false,
                capabilities: OPENAI_RESPONSES_CAPABILITIES,
                headers: {
                    "HTTP-Referer": "https://github.com/slopus/rig",
                    "X-OpenRouter-Title": "Rig server tool result live coverage",
                },
            });
            const session = await provider.session(`openrouter-anthropic-live-${Date.now()}`, {
                instructions: "You are a concise assistant.",
                tools: [{ name: "web_search", server: { type: "web_search" } }],
            });
            const events = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text" as const,
                                        text: "Search the web for the current Node.js LTS version and reply with one official URL.",
                                    },
                                ],
                            },
                        ],
                    },
                }),
            );

            // OpenRouter may or may not honor Responses server web_search for Anthropic models.
            // Accept either a completed server search or a normal text answer; never a stalled
            // client tool loop for a tool Rig does not execute.
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(
                events.filter((event) => event.type === "toolcall_start" && event.server !== true),
            ).toEqual([]);
            if (serverStarts(events).length > 0) {
                expect(serverStarts(events).every((event) => event.name === "web_search")).toBe(
                    true,
                );
            }
            expect(textFromSessionEvents(events).length).toBeGreaterThan(0);
        },
    );
});
