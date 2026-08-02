import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";
import { toGrokToolDefinitions } from "@/vendors/grok/impl/toGrokToolDefinitions.js";
import { grok_hosted_tools } from "@/vendors/grok/tools/index.js";

/**
 * Grok answers a question about X or the web by running the search on its own backend inside one
 * response. These goldens come from real CLI 0.2.118 traffic and pin the two halves that make
 * that work: asking for the hosted tool, and reading back calls the client must never execute.
 */
describe("Grok hosted search goldens", () => {
    it("declares hosted search the way the captured CLI request does", async () => {
        const golden = await fixture("grok-4-5-x-search.sse.json");
        const hosted = golden.request.tools.filter(
            (tool: { type: string }) => tool.type === "web_search" || tool.type === "x_search",
        );
        expect(hosted).toEqual([{ type: "web_search" }, { type: "x_search" }]);
        expect(toGrokToolDefinitions(grok_hosted_tools)).toEqual(hosted);
    });

    it("sends hosted tools alongside the tools Rig executes", async () => {
        const captured = await captureRequest({ hostedTools: grok_hosted_tools });
        expect(captured.tools).toEqual([
            { type: "function", name: "read_file", description: "Read a file." },
            { type: "web_search" },
            { type: "x_search" },
        ]);
    });

    it("sends no hosted tools when a session does not ask for them", async () => {
        const captured = await captureRequest({});
        expect(captured.tools).toEqual([
            { type: "function", name: "read_file", description: "Read a file." },
        ]);
    });

    it("leaves hosted search out of compaction, which has nothing to search for", async () => {
        const captured = await captureRequest({
            hostedTools: grok_hosted_tools,
            compaction: true,
        });
        expect(captured.tools).toEqual([
            { type: "function", name: "read_file", description: "Read a file." },
        ]);
        expect(captured.temperature).toBe(1);
    });

    it("reports captured X search as provider-executed rather than a call Rig must answer", async () => {
        const golden = await fixture("grok-4-5-x-search.sse.json");
        const { events, result } = await replay(golden);

        expect(
            events.flatMap((event) =>
                event.type === "server_tool_call_start" ? [event.name] : [],
            ),
        ).toEqual(["x_keyword_search", "x_semantic_search"]);
        expect(
            events.flatMap((event) =>
                event.type === "server_tool_call_end" ? [JSON.parse(event.arguments)] : [],
            ),
        ).toEqual([
            { query: "Claude Code", limit: "5", mode: "Latest" },
            { query: "Claude Code", limit: "5" },
        ]);

        // The client is never asked to run these, so the turn is a finished answer, not a tool loop.
        expect(events.filter((event) => event.type === "tool_call_start")).toEqual([]);
        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
        expect(result.assistantText).toContain("https://x.com/");
    });

    it("reports captured web search as provider-executed and keeps its queried sources", async () => {
        const golden = await fixture("grok-4-5-web-search.sse.json");
        const { events, result } = await replay(golden);

        expect(
            events.flatMap((event) =>
                event.type === "server_tool_call_start" ? [event.name] : [],
            ),
        ).toEqual(["web_search"]);
        const ended = events.find((event) => event.type === "server_tool_call_end");
        expect(JSON.parse(ended!.arguments as string)).toMatchObject({
            type: "search",
            query: "Node.js current stable version",
        });
        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
    });

    it("replays hosted calls verbatim without inventing tool output for them", async () => {
        const golden = await fixture("grok-4-5-x-search.sse.json");
        const { result } = await replay(golden);

        const input = toGrokResponseInput({
            instructions: "System prompt.",
            messages: [
                { role: "user", content: "Search X for the latest posts about 'Claude Code'." },
                {
                    role: "assistant",
                    content: result.assistantText,
                    responseItems: result.responseItems,
                },
                { role: "user", content: "Who posted first?" },
            ],
        });

        // Grok carries the search results in its own encrypted reasoning, so the hosted calls
        // return exactly as they arrived and nothing pairs a fabricated output with them.
        const hostedCalls = input.filter(
            (item: any) => item.type === "custom_tool_call" && item.name.startsWith("x_"),
        );
        expect(hostedCalls.map((item: any) => item.name)).toEqual([
            "x_keyword_search",
            "x_semantic_search",
        ]);
        expect(input.filter((item: any) => item.type === "custom_tool_call_output")).toEqual([]);
        expect(input.filter((item: any) => item.type === "function_call_output")).toEqual([]);
    });

    it("keeps an undeclared custom tool executable when the client declared no tool names", async () => {
        const events: SessionEvent[] = [];
        const mapped = mapOpenAIResponseStream(
            stream([
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "grammar_tool",
                        input: "",
                    },
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "grammar_tool",
                        input: "print(1)",
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ]),
            { failureMessage: "unused" },
        );
        let next = await mapped.next();
        while (next.done !== true) {
            events.push(next.value);
            next = await mapped.next();
        }
        expect(next.value.toolCalls.map((call) => call.name)).toEqual(["grammar_tool"]);
        expect(events.some((event) => event.type === "server_tool_call_start")).toBe(false);
    });
});

const readFileTool: SessionTool = {
    name: "read_file",
    type: "local",
    description: "Read a file.",
};

async function replay(golden: any) {
    const events: SessionEvent[] = [];
    const clientToolNames = new Set<string>(
        golden.request.tools.flatMap((tool: { name?: string }) =>
            tool.name === undefined ? [] : [tool.name],
        ),
    );
    const mapped = mapOpenAIResponseStream(stream(golden.response.events), {
        failureMessage: "Captured Grok response failed.",
        requireTerminalEvent: true,
        vendor: "grok",
        clientToolNames,
    });
    let next = await mapped.next();
    while (next.done !== true) {
        events.push(next.value);
        next = await mapped.next();
    }
    return { events, result: next.value };
}

/** Runs one Grok session against a local endpoint and returns the request body it sent. */
async function captureRequest(options: {
    hostedTools?: readonly SessionTool[];
    compaction?: boolean;
}) {
    let capturedBody: any;
    const summary = `<summary>${"Summarized session state. ".repeat(40)}</summary>`;
    const server = createServer(async (request, response) => {
        capturedBody = JSON.parse(await readBody(request));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
            `${sse({
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg", role: "assistant", content: [] },
            })}${sse({
                type: "response.output_text.delta",
                output_index: 0,
                delta: summary,
            })}${sse({
                type: "response.completed",
                response: { id: "response", output: [], usage: { total_tokens: 1 } },
            })}data: [DONE]\n\n`,
        );
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Missing port.");
    try {
        const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test" });
        if (credential === null) throw new Error("Missing test credential.");
        const provider = new GrokProvider({
            credential,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            model: "grok-4.5",
            ...(options.hostedTools === undefined ? {} : { hostedTools: options.hostedTools }),
        });
        const session = await provider.session("<SESSION_ID>", {
            instructions: "System prompt.",
            tools: [readFileTool],
        });
        for await (const _event of session.run({
            context: { messages: [{ role: "user", content: "Hi." }] },
        })) {
            // Drained so the request completes.
        }
        if (options.compaction === true) {
            capturedBody = undefined;
            const compacted = await session.compact();
            expect(compacted.status).toBe("completed");
        }
        return capturedBody;
    } finally {
        server.close();
    }
}

async function fixture(name: string): Promise<any> {
    return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.once("end", () => resolve(body));
        request.once("error", reject);
    });
}

async function* stream(events: readonly unknown[]): AsyncIterable<any> {
    for (const event of events) yield event;
}

function sse(event: unknown): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}
