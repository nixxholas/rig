import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import { createOpenAIResponseRequest } from "@/protocol/responses/createOpenAIResponseRequest.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

describe("ResponsesProvider", () => {
    it("runs the standard Responses SSE protocol with configured endpoint and model", async () => {
        let requestBody: unknown;
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async (_input, init) => {
                requestBody = JSON.parse(String(init?.body));
                return sseResponse([
                    {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { type: "message", id: "message-1", role: "assistant", content: [] },
                    },
                    {
                        type: "response.output_text.delta",
                        output_index: 0,
                        content_index: 0,
                        delta: "protocol ok",
                    },
                    {
                        type: "response.output_item.done",
                        output_index: 0,
                        item: {
                            type: "message",
                            id: "message-1",
                            role: "assistant",
                            status: "completed",
                            content: [
                                { type: "output_text", text: "protocol ok", annotations: [] },
                            ],
                        },
                    },
                    {
                        type: "response.completed",
                        response: {
                            id: "response-1",
                            output: [
                                {
                                    type: "message",
                                    id: "message-1",
                                    role: "assistant",
                                    status: "completed",
                                    content: [
                                        {
                                            type: "output_text",
                                            text: "protocol ok",
                                            annotations: [],
                                        },
                                    ],
                                },
                            ],
                            usage: {
                                input_tokens: 10,
                                input_tokens_details: { cached_tokens: 2 },
                                output_tokens: 3,
                                output_tokens_details: { reasoning_tokens: 0 },
                                total_tokens: 13,
                            },
                        },
                    },
                ]);
            },
        });
        const session = await provider.session("responses-session", {
            instructions: "Be concise.",
            tools: [
                {
                    name: "lookup",
                    type: "local",
                    description: "Look something up.",
                    parameters: Type.Object({ query: Type.String() }),
                },
            ],
        });

        const events = await collectSessionEvents(
            session.run({
                context: { messages: [{ role: "user", content: "Check the protocol." }] },
            }),
        );

        expect(textFromSessionEvents(events)).toBe("protocol ok");
        expect(events.at(-2)).toEqual({ type: "block_stop" });
        expect(events.some((event) => event.type === "done" && event.state === "normal")).toBe(
            true,
        );
        expect(requestBody).toMatchObject({
            model: "open-model",
            stream: true,
            store: false,
            instructions: "Be concise.",
            input: [{ role: "user", content: "Check the protocol." }],
            tools: [
                {
                    type: "function",
                    name: "lookup",
                    description: "Look something up.",
                    parameters: {
                        type: "object",
                        properties: { query: { type: "string" } },
                        required: ["query"],
                    },
                },
            ],
        });
        expect(requestBody).not.toHaveProperty("parallel_tool_calls");
        expect(requestBody).not.toHaveProperty("text");
    });

    it("configures optional request features through capabilities", () => {
        const request = createOpenAIResponseRequest({
            capabilities: {
                encryptedReasoning: false,
                parallelToolCalls: true,
                reasoning: true,
                textVerbosity: false,
            },
            context: {
                instructions: "Be concise.",
                messages: [{ role: "user", content: "Hello." }],
            },
            effort: "high",
            model: "open-model",
        });

        expect(request.parallel_tool_calls).toBe(true);
        expect(request.text).toBeUndefined();
        expect(request.reasoning).toEqual({ effort: "high" });
        expect(request.include).toBeUndefined();
    });

    it("uses the native Responses compact endpoint and preserves its opaque item", async () => {
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async (input) => {
                expect(String(input)).toContain("/responses/compact");
                return Response.json({
                    id: "compacted-response-1",
                    object: "response.compaction",
                    created_at: 1,
                    output: [
                        {
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text: "Provider kept this." }],
                        },
                        {
                            id: "compaction-1",
                            type: "compaction",
                            encrypted_content: "opaque-checkpoint",
                        },
                    ],
                    usage: {
                        input_tokens: 20,
                        input_tokens_details: { cached_tokens: 5 },
                        output_tokens: 4,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 24,
                    },
                });
            },
        });
        const session = await provider.session("responses-compaction", {
            instructions: "Preserve state.",
            tools: [],
        });

        await expect(
            session.compact({
                context: {
                    messages: [
                        { role: "user", content: "Provider dropped this." },
                        { role: "user", content: "Provider kept this." },
                    ],
                },
            }),
        ).resolves.toMatchObject({
            status: "completed",
            compaction: {
                role: "compaction",
                content: null,
                encryptedContent: "opaque-checkpoint",
                vendor: { type: "responses_compaction", id: "compaction-1" },
            },
            preservedMessages: [{ role: "user", content: "Provider kept this." }],
            usage: {
                input: 15,
                output: 4,
                cacheRead: 5,
                totalTokens: 24,
            },
        });
    });

    it("emits nothing when inference is already aborted", async () => {
        const provider = new ResponsesProvider({
            apiKey: "test-key",
            endpoint: "https://responses.example/v1",
            model: "open-model",
            fetch: async () => {
                throw new Error("A pre-aborted run must not reach the network.");
            },
        });
        const session = await provider.session("responses-aborted", {
            instructions: "",
            tools: [],
        });
        const controller = new AbortController();
        controller.abort();
        const events = [];

        for await (const event of session.run({
            abort: controller.signal,
            context: { messages: [{ role: "user", content: "Do not send." }] },
        })) {
            events.push(event);
        }

        expect(events).toEqual([]);
    });
});

function sseResponse(events: readonly unknown[]): Response {
    const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}
