import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createGymProvider, gymModel } from "./createGymProvider.js";

describe("createGymProvider", () => {
    it("normalizes a host response into provider streaming events", async () => {
        const requests: unknown[] = [];
        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                expect(request.headers.authorization).toBe("Bearer secret");
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        content: [{ text: "hello", type: "text" }],
                        stopReason: "stop",
                    }),
                );
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing port.");
        try {
            const provider = createGymProvider({
                endpoint: `http://127.0.0.1:${address.port}`,
                token: "secret",
            });
            expect(provider.serviceTiers).toEqual(["fast"]);
            const stream = provider.stream(
                gymModel,
                { messages: [{ content: "Hi", role: "user", timestamp: 1 }] },
                { sessionId: "session-1", thinking: "off" },
            );
            const events = [];
            for await (const event of stream) events.push(event);

            await expect(stream.result()).resolves.toMatchObject({
                content: [{ text: "hello", type: "text" }],
                provider: "gym",
                stopReason: "stop",
            });
            expect(events.map((event) => event.type)).toEqual([
                "start",
                "text_start",
                "text_delta",
                "text_end",
                "done",
            ]);
            expect(requests).toMatchObject([
                {
                    modelId: "openai/gym",
                    options: { sessionId: "session-1", thinking: "off" },
                },
            ]);
        } finally {
            server.close();
        }
    });

    it("surfaces mocked HTTP failures", async () => {
        const server = createServer((_request, response) => {
            response.writeHead(429);
            response.end("scripted overload");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing port.");
        try {
            const provider = createGymProvider({
                endpoint: `http://127.0.0.1:${address.port}`,
            });
            const stream = provider.stream(gymModel, { messages: [] });
            await expect(stream.result()).rejects.toThrow("HTTP 429: scripted overload");
        } finally {
            server.close();
        }
    });

    it("uses the mock provider's native replacement context for compaction", async () => {
        const replacement = {
            messages: [
                {
                    role: "compaction" as const,
                    content: null,
                    encryptedContent: "opaque",
                    timestamp: 7,
                },
            ],
        };
        const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(String(init?.body)) as {
                options: { intent?: string };
            };
            expect(payload.options.intent).toBe("compaction");
            return new Response(
                JSON.stringify({
                    compactionContext: replacement,
                    content: [],
                }),
                { status: 200 },
            );
        });
        const provider = createGymProvider({
            endpoint: "https://gym.test/inference",
            fetch: request as typeof fetch,
        });

        await expect(
            provider.compact?.({
                context: { messages: [{ role: "user", content: "old", timestamp: 1 }] },
                inputTokens: 100,
                model: gymModel,
            }),
        ).resolves.toMatchObject({
            status: "completed",
            context: replacement,
        });
        expect(request).toHaveBeenCalledOnce();
    });

    it("keeps runtime model identity when a native provider prepares the prompt", async () => {
        let payload:
            | {
                  context: { systemPrompt?: string; systemPromptOverride?: string };
              }
            | undefined;
        const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            payload = JSON.parse(String(init?.body)) as typeof payload;
            return new Response(
                JSON.stringify({
                    content: [{ text: "prepared", type: "text" }],
                    stopReason: "stop",
                }),
                { status: 200 },
            );
        });
        const prepareContext = vi.fn(async (_model, context) => ({
            ...context,
            systemPrompt: `Native prompt\n\n${context.systemPrompt ?? ""}`,
        }));
        const provider = createGymProvider({
            endpoint: "https://gym.test/inference",
            fetch: request as typeof fetch,
            prepareContext,
            providerId: "bedrock",
        });

        await provider
            .stream(
                gymModel,
                {
                    messages: [],
                    systemPrompt: "Rig instructions",
                    systemPromptOverride: "User override",
                },
                { sessionId: "prepared-session" },
            )
            .result();

        expect(prepareContext).toHaveBeenCalledOnce();
        expect(payload?.context.systemPrompt).toContain("Native prompt");
        expect(payload?.context.systemPrompt).toContain(
            "# Runtime model\nModel ID: openai/gym\nProvider ID: bedrock",
        );
        expect(payload?.context.systemPrompt).toContain("Rig instructions");
        expect(payload?.context.systemPromptOverride).toBe("User override");
    });
});
