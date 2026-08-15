import { describe, expect, it } from "vitest";

import { createInferenceStream } from "@slopus/rig-execution";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type RawQueryOptions,
} from "@slopus/rig-execution";
import type { Context as RuntimeContext } from "@steve.kite/stdlib";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { generateSessionMetadata, parseSessionMetadata } from "../generateSessionMetadata.js";

const ctx = createTestRootContext().named("generate-session-metadata-test");

function assistantMessage(text: string, model: string, provider: string): AssistantMessage {
    return {
        api: "test",
        content: text.length === 0 ? [] : [{ text, type: "text" }],
        model,
        provider,
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}

describe("parseSessionMetadata", () => {
    it("reads the tagged answer out of whatever else the model said", async () => {
        expect(
            parseSessionMetadata(
                "Sure! Here is the metadata:\n" +
                    "<title>Delayed session metadata</title>\n" +
                    "<recap>The user added delayed metadata. The implementation is complete.</recap>\n" +
                    "Let me know if you want another one.",
            ),
        ).toEqual({
            recap: "The user added delayed metadata. The implementation is complete.",
            title: "Delayed session metadata",
        });
    });

    it("shortens an oversized answer instead of throwing the whole title away", async () => {
        const parsed = parseSessionMetadata(
            `<title>${"Word ".repeat(12).trim()}</title><recap>One. Two. Three.</recap>`,
        );

        expect(parsed.title).toBe("Word Word Word Word Word Word");
        expect(parsed.recap).toBe("One. Two.");
    });

    it("refuses an answer that named nothing", async () => {
        expect(() => parseSessionMetadata("I could not think of a title.")).toThrow(
            "must contain a title and a recap",
        );
        expect(() => parseSessionMetadata("<title>Only a title</title>")).toThrow(
            "must contain a title and a recap",
        );
    });

    it("asks the bare provider for the title, carrying the stored session start date", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-5.4",
            name: "Metadata model",
            thinkingLevels: ["off"],
        });
        let observed: RawQueryOptions | undefined;
        const provider = {
            ...defineProvider({
                id: "codex",
                models: [model],
                stream() {
                    throw new Error("Naming a chat must not run coding-agent inference.");
                },
            }),
            rawQuery: async (_ctx: RuntimeContext, options: RawQueryOptions) => {
                observed = options;
                return "<title>Stable session date</title><recap>The stored session date was forwarded.</recap>";
            },
        };

        await generateSessionMetadata(ctx, {
            modelId: model.id,
            provider,
            sessionId: "session-1",
            startDate: "2024-01-02",
            transcript: "User: Keep the date stable.",
        });

        expect(observed?.sessionId).toBe("session-1:title");
        expect(observed?.startDate).toBe("2024-01-02");
        expect(observed?.model.id).toBe(model.id);
        // The instructions are the naming task and nothing else: no coding agent, no environment.
        expect(observed?.instructions).toContain("<title>");
        expect(observed?.instructions).not.toContain("software engineering");
        expect(observed?.prompt).toContain("User: Keep the date stable.");
    });

    it("names the session with a cheap model from the session model's own family", async () => {
        // Bedrock serves both families, and reaching across them to name a chat asks the session's
        // Claude provider for a GPT model, which it cannot serve.
        const models = [
            defineModel({
                defaultThinkingLevel: "off",
                id: "openai/gpt-5.6-sol",
                name: "Sol",
                thinkingLevels: ["off"],
            }),
            defineModel({
                defaultThinkingLevel: "off",
                id: "anthropic/sonnet-5",
                name: "Sonnet",
                thinkingLevels: ["off"],
            }),
            defineModel({
                defaultThinkingLevel: "off",
                id: "anthropic/fable-5",
                name: "Fable",
                thinkingLevels: ["off"],
            }),
        ];
        const observed: string[] = [];
        const provider = {
            ...defineProvider({
                id: "bedrock",
                models,
                stream() {
                    throw new Error("Naming a chat must not run coding-agent inference.");
                },
            }),
            rawQuery: async (_ctx: RuntimeContext, options: RawQueryOptions) => {
                observed.push(options.model.id);
                return "<title>Metadata stays in family</title><recap>The title model matched the session family.</recap>";
            },
        };

        await generateSessionMetadata(ctx, {
            modelId: "anthropic/fable-5",
            provider,
            sessionId: "session-1",
            transcript: "User: Name this chat.",
        });

        expect(observed).toEqual(["anthropic/sonnet-5"]);
    });

    it("reports a provider failure as itself rather than as an unreadable answer", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-5.6-sol",
            name: "Sol",
            thinkingLevels: ["off"],
        });
        // A failed response carries no text at all, which is exactly how a real provider failure
        // used to reach the parser and be reported as malformed output.
        const failed: AssistantMessage = {
            ...assistantMessage("", model.id, "codex"),
            errorMessage: "The account is out of capacity.",
            stopReason: "error",
        };
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return createInferenceStream(async function* () {
                    yield { error: failed, reason: "error", type: "error" };
                    return failed;
                });
            },
        });

        await expect(
            generateSessionMetadata(ctx, {
                modelId: model.id,
                provider,
                sessionId: "session-1",
                transcript: "User: Name this chat.",
            }),
        ).rejects.toThrow("The account is out of capacity.");
    });

    it("settles cancellation even when the provider ignores its abort signal", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-5.6-sol",
            name: "Sol",
            thinkingLevels: ["off"],
        });
        const provider = {
            ...defineProvider({
                id: "codex",
                models: [model],
                stream() {
                    throw new Error("Naming a chat must not run coding-agent inference.");
                },
            }),
            rawQuery: () => new Promise<string>(() => {}),
        };
        const controller = new AbortController();
        const metadata = generateSessionMetadata(ctx, {
            modelId: model.id,
            provider,
            sessionId: "session-1",
            signal: controller.signal,
            transcript: "User: Do not hang after cancellation.",
        });

        controller.abort();

        await expect(metadata).rejects.toThrow("cancelled");
    });
});
