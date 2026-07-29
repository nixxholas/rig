import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";

describe("Grok user agent", () => {
    it("reproduces the grok-shell user agent when the caller does not identify itself", async () => {
        const headers = await runOnce({});

        expect(headers?.["user-agent"]).toMatch(/^grok-shell\/\S+ \(.+; .+\)$/);
    });

    it("identifies the caller when it supplies a user agent", async () => {
        const headers = await runOnce({ userAgent: "rig/1.2.3" });

        expect(headers?.["user-agent"]).toBe("rig/1.2.3");
    });
});

async function runOnce(options: {
    userAgent?: string;
}): Promise<IncomingMessage["headers"] | undefined> {
    let headers: IncomingMessage["headers"] | undefined;
    const server = createServer((request, response) => {
        headers = request.headers;
        request.resume();
        request.once("end", () => completeSse(response));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Grok test server port.");
    }
    const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "grok-user-agent-key" });
    if (credential === null) throw new Error("Expected a Grok test credential.");
    const provider = new GrokProvider({
        credential,
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: "grok-4.5",
        ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    });
    const session = await provider.session("user-agent-session", {
        instructions: "",
        tools: [],
    });
    try {
        for await (const _event of session.run({
            context: { messages: [{ role: "user", content: "Hello." }] },
        })) {
            // Draining the stream is what performs the request under test.
        }
    } finally {
        session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return headers;
}

function completeSse(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        `data: ${JSON.stringify({
            type: "response.completed",
            response: {
                id: "response",
                output: [],
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
        })}\n\ndata: [DONE]\n\n`,
    );
}
