import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { collectSessionEvents } from "../helpers/collectSessionEvents.js";

describe("Claude retry contract", () => {
    const sessions: ClaudeSession[] = [];
    const servers: ReturnType<typeof createServer>[] = [];

    afterEach(async () => {
        for (const session of sessions) session.destroy();
        await Promise.all(
            servers.map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => resolve());
                    }),
            ),
        );
    });

    it("retries an HTTP 500 through the real SDK transport", { timeout: 15_000 }, async () => {
        const successEvents = await recordedSuccessEvents();
        let requestCount = 0;
        const requestUrls: string[] = [];
        const server = createServer((request, response) => {
            requestUrls.push(request.url ?? "");
            if (
                request.method !== "POST" ||
                !request.url?.startsWith("/v1/messages") ||
                request.url.includes("/count_tokens")
            ) {
                response.writeHead(404, { "content-type": "application/json" });
                response.end('{"type":"error","error":{"type":"not_found_error"}}');
                return;
            }
            requestCount += 1;
            // Claude's HTTP client consumes its own retries before Claude Code emits api_retry.
            // Crossing that inner boundary verifies both transport retries and the surfaced event.
            if (requestCount <= 3) {
                response.writeHead(500, {
                    "content-type": "application/json",
                });
                response.end(
                    JSON.stringify({
                        type: "error",
                        error: { type: "api_error", message: "Internal server error" },
                    }),
                );
                return;
            }
            response.writeHead(200, {
                "content-type": "text/event-stream",
                "request-id": "request-after-retry",
            });
            response.end(toSse(successEvents));
        });
        servers.push(server);
        await listen(server);

        const events = await runAgainst(server);

        expect(requestCount).toBe(4);
        expect(requestUrls.filter((url) => url.startsWith("/v1/messages"))).toHaveLength(4);
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "retrying",
                attempt: 1,
            }),
        );
        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
    });

    async function runAgainst(server: ReturnType<typeof createServer>): Promise<SessionEvent[]> {
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing Claude retry server port.");
        }
        const credential = await ClaudeAuthTokenCredential.tryLoad({
            authToken: "retry-test-token",
        });
        if (credential === null) throw new Error("Expected a Claude test credential.");
        const session = new ClaudeSession("claude-retry", {
            instructions: "",
            credential,
            env: {
                ...process.env,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
            model: "opus[1m]",
            tools: [],
        });
        sessions.push(session);
        return collectSessionEvents(
            session.run({
                context: { messages: [{ role: "user", content: "Retry this request." }] },
            }),
        );
    }
});

async function recordedSuccessEvents(): Promise<unknown[]> {
    const fixture = JSON.parse(
        await readFile(
            new URL("./fixtures/claude-provider-multiturn.json", import.meta.url),
            "utf8",
        ),
    );
    return fixture.exchanges[1].response.events;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}

function toSse(events: readonly unknown[]): string {
    return events
        .map(
            (event) =>
                `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
}
