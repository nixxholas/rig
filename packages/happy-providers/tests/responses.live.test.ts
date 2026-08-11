import { describe, expect, it } from "vitest";

import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import { OPENAI_RESPONSES_CAPABILITIES } from "@/protocol/responses/ResponsesCapabilities.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const LIVE = process.env.RIG_LIVE_TEST === "1" && apiKey !== undefined;
const describeLive = LIVE ? describe : describe.skip;

describeLive("ResponsesProvider through OpenRouter", () => {
    it("runs the standard Responses API against an open model", async () => {
        const provider = new ResponsesProvider({
            apiKey: apiKey!,
            endpoint: "https://openrouter.ai/api/v1",
            model: "moonshotai/kimi-k3",
            nativeCompaction: false,
            capabilities: OPENAI_RESPONSES_CAPABILITIES,
            headers: {
                "HTTP-Referer": "https://github.com/slopus/rig",
                "X-OpenRouter-Title": "Rig Responses protocol verification",
            },
        });
        const session = await provider.session(`openrouter-responses-${Date.now()}`, {
            instructions: "You are a concise assistant.",
            tools: [],
        });
        const events = await collectSessionEvents(
            session.run({
                context: {
                    messages: [
                        {
                            role: "user",
                            content: "Reply with exactly: openrouter responses live ok",
                        },
                    ],
                },
            }),
        );

        expect(events.at(-1)).toEqual({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events).toLowerCase()).toContain(
            "openrouter responses live ok",
        );
        expect(events.some((event) => event.type === "token_usage")).toBe(true);
    }, 120_000);
});
