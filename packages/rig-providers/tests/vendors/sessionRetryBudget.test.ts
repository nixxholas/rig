import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";

/**
 * A session may refuse the provider's retry budget.
 *
 * Retries belong to the provider, and a conversation is right to sit through them. A bounded
 * request made on the side of somebody's turn is not: it holds a tool call open for every attempt
 * and the person watching learns nothing until the last one fails. So the caller opening that
 * session names its own budget, and the provider honors it instead of its own.
 */
describe("session retry budget", () => {
    const servers: Server[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => resolve());
                    }),
            ),
        );
    });

    it("sends one request when the session refuses retries", async () => {
        const { events, requests } = await run({ inferenceMaxRetries: 0 });

        expect(requests).toBe(1);
        expect(events.filter((event) => event.type === "retrying")).toEqual([]);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "internal_server_error" },
        });
    });

    it("keeps the provider's own budget when the session names none", async () => {
        const { events, requests } = await run({});

        expect(requests).toBe(3);
        expect(events).toContainEqual(expect.objectContaining({ type: "retrying", attempt: 1 }));
    });

    async function run(sessionOptions: {
        inferenceMaxRetries?: number;
    }): Promise<{ events: SessionEvent[]; requests: number }> {
        let requests = 0;
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                // Drain the request before answering.
            }
            requests += 1;
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "The server had an error." } }));
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", resolve);
            server.once("error", reject);
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) expect.fail("Missing server port.");

        const provider = new CodexProvider({
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            // Two retries make the difference between an honored budget and the provider's own
            // visible without spending a long backoff on it.
            inferenceMaxRetries: 2,
            model: "gpt-5.6-sol",
            transport: "sse",
            userAgent: "rig-test",
            waitForInferenceRetry: async () => {
                // The schedule itself is covered elsewhere; this test counts attempts.
            },
        });
        const session = await provider.session("session-retry-budget", {
            ...sessionOptions,
            instructions: "Be brief.",
            tools: [],
        });
        const events: SessionEvent[] = [];
        try {
            for await (const event of session.run({
                context: { messages: [{ role: "user", content: "Reply with OK." }] },
                effort: "low",
            })) {
                events.push(event);
            }
        } finally {
            session.destroy();
        }
        return { events, requests };
    }
});
