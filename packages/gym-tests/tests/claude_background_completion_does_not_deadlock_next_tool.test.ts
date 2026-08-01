import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const servers = new Set<Server>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(
        [...servers].map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                }),
        ),
    );
    servers.clear();
});

describe("Claude background completion during the next tool", () => {
    it("replays the completed tool result and system notice instead of deadlocking", async () => {
        const firstPrompt = "START_CLAUDE_BACKGROUND_COMPLETION_RACE";
        const recovered = "CLAUDE_RECOVERED_AFTER_BACKGROUND_COMPLETION";
        let signalBackgroundFinishing = () => {};
        const backgroundFinishing = new Promise<void>((resolve) => {
            signalBackgroundFinishing = resolve;
        });
        let sawBackgroundNotice = false;
        const server = createServer((request, response) => {
            void (async () => {
                if (request.url === "/background-finishing") {
                    signalBackgroundFinishing();
                    response.writeHead(204).end();
                    return;
                }
                if (request.url !== "/v1/messages?beta=true") {
                    response.writeHead(404).end("Unexpected request.");
                    return;
                }
                const payload = JSON.parse(await requestText(request)) as AnthropicRequestPayload;
                const messages = JSON.stringify(payload.messages);
                if (messages.includes("Background command")) {
                    sawBackgroundNotice = true;
                    await writeStream(response, textEvents(payload.model, recovered));
                    return;
                }
                if (messages.includes("tool_result")) {
                    await backgroundFinishing;
                    await writeStream(
                        response,
                        bashToolEvents(payload, "foreground-after-background", {
                            command: "sleep 60",
                            description: "Wait after the background command",
                        }),
                    );
                    return;
                }
                if (messages.includes(firstPrompt)) {
                    const address = server.address() as AddressInfo;
                    await writeStream(
                        response,
                        bashToolEvents(payload, "start-background", {
                            command: [
                                "sleep 4",
                                "printf 'finished\\n' > background-finished.txt",
                                `node -e "fetch('http://host.docker.internal:${String(address.port)}/background-finishing')"`,
                            ].join("; "),
                            run_in_background: true,
                        }),
                    );
                    return;
                }
                await writeStream(response, textEvents(payload.model, "UNEXPECTED_REQUEST"));
            })().catch((error: unknown) => {
                if (!response.headersSent) response.writeHead(500);
                response.end(error instanceof Error ? error.message : String(error));
            });
        });
        servers.add(server);
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "0.0.0.0", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address() as AddressInfo;
        const gym = await createGym({
            environment: {
                ANTHROPIC_API_KEY: "gym-placeholder-key",
                ANTHROPIC_BASE_URL: `http://host.docker.internal:${String(address.port)}`,
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_TELEMETRY: "1",
                NO_PROXY: "host.docker.internal",
            },
            mode: "docker",
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
            timeoutMs: 30_000,
        });
        running.add(gym);

        gym.terminal.type(firstPrompt);
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(recovered, 30_000);
        expect(screen.text).toContain(recovered);
        expect(sawBackgroundNotice).toBe(true);
        await expect(gym.readFile("background-finished.txt")).resolves.toBe("finished\n");
    }, 120_000);
});

function bashToolEvents(
    payload: AnthropicRequestPayload,
    callId: string,
    input: Readonly<Record<string, unknown>>,
): readonly Record<string, unknown>[] {
    const bashName = payload.tools?.find((tool) => tool.name.endsWith("Bash"))?.name ?? "Bash";
    return messageEvents(payload.model, [
        {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: callId,
                name: bashName,
                input: {},
                caller: { type: "direct" },
            },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(input),
            },
        },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null },
            usage: { output_tokens: 1 },
            context_management: { applied_edits: [] },
        },
        { type: "message_stop" },
    ]);
}

function textEvents(model: string | undefined, text: string): readonly Record<string, unknown>[] {
    return messageEvents(model, [
        {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
    ]);
}

function messageEvents(
    model: string | undefined,
    contentEvents: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
    return [
        {
            type: "message_start",
            message: {
                id: "msg_gym_claude_background_completion",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    output_tokens: 1,
                },
            },
        },
        ...contentEvents,
    ];
}

async function writeStream(
    response: ServerResponse,
    events: readonly Record<string, unknown>[],
): Promise<void> {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) {
        if (response.destroyed) return;
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    response.end();
}

async function requestText(request: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString("utf8");
}

interface AnthropicRequestPayload {
    messages?: unknown;
    model?: string;
    tools?: readonly { name: string }[];
}
