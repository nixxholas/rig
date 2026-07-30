import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";

import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
} from "@slopus/rig-execution";
import { requestProviderCompaction } from "./requestProviderCompaction.js";

const model = defineModel({
    id: "openai/test",
    name: "Test",
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
});

describe("requestProviderCompaction", () => {
    it("returns native provider compaction without synthesizing a summary", async () => {
        const checkpoint = {
            role: "compaction" as const,
            content: "Provider-authored continuation text.",
            encryptedContent: "opaque-compaction-metadata",
            timestamp: 4,
        };
        const context = {
            ...compactionContext(),
            messages: [checkpoint],
        };
        const provider = defineProvider({
            id: "test",
            models: [model],
            compact: async () => ({
                status: "completed",
                compaction: checkpoint,
                context,
                usage: zeroUsage(),
            }),
            stream() {
                throw new Error("Opaque compaction must not fall back to inference.");
            },
        });

        const result = await requestProviderCompaction({
            context: compactionContext(),
            inputTokens: 1_000,
            model,
            now: () => 4,
            provider,
        });

        expect(result).toMatchObject({ context, usage: zeroUsage() });
        expect(result).not.toHaveProperty("summary");
    });

    it("does not invent an inference fallback for providers without compaction", async () => {
        let requests = 0;
        const provider = defineProvider({
            id: "test",
            models: [model],
            stream() {
                requests += 1;
                throw new Error("Compaction must not use ordinary inference.");
            },
        });

        await expect(
            requestProviderCompaction({
                context: compactionContext(),
                inputTokens: 1_000,
                model,
                now: () => 4,
                provider,
            }),
        ).rejects.toThrow("does not support conversation compaction");
        expect(requests).toBe(0);
    });

    it.each([
        ["cancelled", { status: "cancelled" as const }, "Conversation compaction was stopped."],
        [
            "failed",
            {
                status: "failed" as const,
                kind: "inference_error" as const,
                message: "native compaction failed",
            },
            "native compaction failed",
        ],
    ])(
        "leaves the original context active when provider compaction is %s",
        async (_label, outcome, expected) => {
            const context = compactionContext();
            const provider = defineProvider({
                id: "test",
                models: [model],
                compact: async () => ({ ...outcome, context }),
                stream() {
                    throw new Error("Native compaction must not fall back to inference.");
                },
            });

            await expect(
                requestProviderCompaction({
                    context,
                    inputTokens: 1_000,
                    model,
                    now: () => 1,
                    provider,
                }),
            ).rejects.toThrow(expected);
        },
    );
});

function compactionContext(): Context {
    return {
        systemPrompt: "Stable system prompt.",
        tools: [
            {
                name: "read_file",
                description: "Read one file.",
                parameters: Type.Object({}),
            },
        ],
        messages: [
            { role: "user", content: [{ type: "text", text: "Work." }], timestamp: 1 },
            {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "read_file",
                        arguments: { path: "README.md" },
                    },
                ],
                api: "test",
                provider: "test",
                model: model.id,
                usage: zeroUsage(),
                stopReason: "toolUse",
                timestamp: 2,
            },
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read_file",
                content: [{ type: "text", text: "Contents." }],
                isError: false,
                timestamp: 3,
            },
        ],
    };
}

function zeroUsage(): AssistantMessage["usage"] {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
    };
}
