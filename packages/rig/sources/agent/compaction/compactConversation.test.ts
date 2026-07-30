import { describe, expect, it, vi } from "vitest";

import { compactConversation } from "./compactConversation.js";
import { toProviderMessages } from "../loop.js";
import type { Message } from "../types.js";
import { defineModel, defineProvider, type Context } from "@slopus/rig-execution";

const model = defineModel({
    id: "openai/test",
    name: "Test",
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
    contextWindow: 1_000,
});

describe("compactConversation", () => {
    it("adopts provider-authored continuation text without comparing it to summary metadata", async () => {
        const source: Message[] = [
            {
                role: "user",
                id: "old-user",
                blocks: [{ type: "text", text: "Old request." }],
            },
            {
                role: "agent",
                id: "old-agent",
                blocks: [{ type: "text", text: "Old response." }],
            },
        ];
        const continuation =
            "<conversation_summary>\nProvider-authored continuation.\n</conversation_summary>";
        const provider = defineProvider({
            id: "test",
            models: [model],
            compact: async (options) => ({
                status: "completed",
                summary: "Different optional metadata.",
                usage: zeroUsage(),
                context: {
                    ...options.context,
                    messages: [{ role: "user", content: continuation, timestamp: 4 }],
                },
            }),
            stream: vi.fn(() => {
                throw new Error("Provider-owned compaction must not use ordinary inference.");
            }),
        });

        const result = await compactConversation({
            provider,
            model,
            messages: source,
            createProviderContext: async () => ({
                messages: [
                    { role: "user", content: "Old request.", timestamp: 1 },
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "Old response." }],
                        api: "test",
                        provider: "test",
                        model: model.id,
                        usage: zeroUsage(),
                        stopReason: "stop",
                        timestamp: 2,
                    },
                ],
            }),
            force: true,
            idFactory: () => "compaction-id",
            now: () => 5,
        });

        expect(result.compactionMessage).toMatchObject({
            blocks: [],
            replacedMessageIds: ["old-user", "old-agent"],
        });
        expect(
            toProviderMessages(result.contextMessages, {
                model,
                now: () => 6,
                providerId: "test",
            }),
        ).toEqual([
            {
                role: "user",
                content: continuation,
                timestamp: 4,
            },
        ]);
    });

    it("passes the full closed context and adopts the provider replacement context", async () => {
        const source: Message[] = [
            {
                role: "user",
                id: "old-user",
                blocks: [{ type: "text", text: "Old request." }],
            },
            {
                role: "agent",
                id: "old-agent",
                blocks: [{ type: "text", text: "Old response." }],
            },
            {
                role: "user",
                id: "current-user",
                blocks: [{ type: "text", text: "Current direction." }],
            },
        ];
        const providerInput: Context = {
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Old request." }],
                    timestamp: 1,
                },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Old response." }],
                    api: "test",
                    provider: "test",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 2,
                },
                {
                    role: "user",
                    content: "Current direction.",
                    sourceMessageId: "current-user",
                    timestamp: 3,
                },
            ],
        };
        let compactedContext: Context | undefined;
        const provider = defineProvider({
            id: "test",
            models: [model],
            compact(options) {
                compactedContext = options.context;
                return Promise.resolve({
                    status: "completed",
                    compaction: {
                        role: "compaction",
                        content: "opaque-checkpoint",
                        encryptedContent: "encrypted-checkpoint",
                        vendor: { id: "checkpoint-1" },
                        timestamp: 4,
                    },
                    usage: zeroUsage(),
                    context: {
                        ...options.context,
                        messages: [
                            options.context.messages[2]!,
                            {
                                role: "compaction",
                                content: "opaque-checkpoint",
                                encryptedContent: "encrypted-checkpoint",
                                vendor: { id: "checkpoint-1" },
                                timestamp: 4,
                            },
                        ],
                    },
                });
            },
            stream: vi.fn(() => {
                throw new Error("Provider-owned compaction must not use ordinary inference.");
            }),
        });

        const result = await compactConversation({
            provider,
            model,
            messages: source,
            createProviderContext: async (messages) => {
                expect(messages).toBe(source);
                return providerInput;
            },
            force: true,
            idFactory: () => "replacement-id",
            now: () => 5,
        });

        expect(compactedContext?.messages).toHaveLength(3);
        expect(compactedContext?.messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
        ]);
        expect(result.contextMessages).toEqual([
            {
                role: "compaction",
                id: "replacement-id",
                blocks: [],
                providerId: "test",
                requestedModelId: model.id,
                replacedMessageIds: ["old-user", "old-agent", "current-user"],
                statistics: {
                    after: { exact: false, tokens: expect.any(Number) },
                    before: { exact: true, tokens: 12 },
                },
                usage: {
                    cacheRead: 4,
                    cacheWrite: 3,
                    cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                        total: 0,
                    },
                    input: 5,
                    output: 3,
                    totalTokens: 15,
                },
                replacementMessages: [
                    providerInput.messages[2],
                    {
                        role: "compaction",
                        content: "opaque-checkpoint",
                        encryptedContent: "encrypted-checkpoint",
                        vendor: { id: "checkpoint-1" },
                        timestamp: 4,
                    },
                ],
            },
        ]);
        expect(result.compactionMessage).not.toBe(result.contextMessages[0]);
        expect(
            toProviderMessages(result.contextMessages, {
                model,
                now: () => 6,
                providerId: "test",
            }).at(-1),
        ).toEqual({
            role: "compaction",
            content: "opaque-checkpoint",
            encryptedContent: "encrypted-checkpoint",
            vendor: { id: "checkpoint-1" },
            timestamp: 4,
        });
        expect(
            toProviderMessages(result.contextMessages, {
                model,
                now: () => 7,
                providerId: "other",
            }).at(-1),
        ).toEqual({
            role: "compaction",
            content: "opaque-checkpoint",
            encryptedContent: "encrypted-checkpoint",
            vendor: { id: "checkpoint-1" },
            timestamp: 4,
        });
    });

    it("replays an arbitrary provider replacement context without interpreting it", async () => {
        const source: Message[] = [
            {
                role: "user",
                id: "old-user",
                blocks: [{ type: "text", text: "Old request." }],
            },
            {
                role: "agent",
                id: "old-agent",
                blocks: [{ type: "text", text: "Old response." }],
            },
        ];
        const replacement: Context["messages"] = [
            {
                role: "assistant",
                content: [{ type: "text", text: "Provider continuation." }],
                api: "native",
                provider: "test",
                model: model.id,
                usage: zeroUsage(),
                stopReason: "stop",
                timestamp: 40,
            },
            { role: "user", content: "Provider follow-up.", timestamp: 41 },
            {
                role: "compaction",
                content: null,
                encryptedContent: "opaque",
                timestamp: 42,
            },
            {
                role: "compaction",
                content: "second checkpoint",
                encryptedContent: null,
                timestamp: 43,
            },
        ];
        const provider = defineProvider({
            id: "test",
            models: [model],
            compact: async (options) => ({
                status: "completed",
                usage: zeroUsage(),
                context: { ...options.context, messages: replacement },
            }),
            stream: vi.fn(() => {
                throw new Error("Provider-owned compaction must not use ordinary inference.");
            }),
        });

        const result = await compactConversation({
            provider,
            model,
            messages: source,
            createProviderContext: async () => ({ messages: [] }),
            force: true,
            idFactory: () => "opaque-context",
            now: () => 50,
        });

        expect(
            toProviderMessages(result.contextMessages, {
                model,
                now: () => 100,
                providerId: "test",
            }),
        ).toEqual(replacement);
    });
});

function zeroUsage() {
    return {
        input: 5,
        output: 3,
        cacheRead: 4,
        cacheWrite: 3,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
