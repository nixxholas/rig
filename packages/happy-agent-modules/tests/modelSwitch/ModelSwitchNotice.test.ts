import type { ModelSwitchNotice } from "../../sources/modelSwitch/impl/createModelSwitchNotice.js";
import { createHistoryExcerpt } from "../../sources/modelSwitch/impl/createHistoryExcerpt.js";
import { createModelSwitchNotice } from "../../sources/modelSwitch/impl/createModelSwitchNotice.js";
import type { HistoryExcerpt } from "../../sources/modelSwitch/impl/createHistoryExcerpt.js";
import type { HistoryBlock } from "../../sources/history/HistoryMessage.js";
import { describe, expect, it } from "vitest";

import { historyMessage, historyRecord } from "./modelSwitchTestSupport.js";

function notice(overrides: Partial<ModelSwitchNotice> = {}): ModelSwitchNotice {
    return {
        previousModel: "Old label",
        previousProvider: "old-provider",
        model: "New label",
        provider: "new-provider",
        ...overrides,
    };
}

function excerpt(overrides: Partial<HistoryExcerpt> = {}): HistoryExcerpt {
    return {
        beginning: "1. USER\nText: Asked for something.",
        recent: "2. ASSISTANT\nText: Finished it.",
        stats: {
            assistantMessages: 1,
            messages: 2,
            textCharacters: 29,
            thinkingBlocks: 0,
            toolCalls: 0,
            toolResults: 0,
            userMessages: 1,
        },
        statsAreSampled: false,
        ...overrides,
    };
}

describe("createModelSwitchNotice", () => {
    it("renders an honest no-history handoff when neither excerpt nor reader exists", () => {
        const text = createModelSwitchNotice(notice());

        expect(text).toContain("<model-switch-history-context>");
        expect(text).toContain("</model-switch-history-context>");
        expect(text).toContain("Old label on old-provider");
        expect(text).toContain("New label on new-provider");
        expect(text).toContain("Durable history lookup is unavailable in this runtime");
        expect(text).toContain("none of it is visible to you");
        expect(text).not.toContain("History overview:");
    });

    it("asks a model with a reader but no excerpt to use the durable history tool", () => {
        const text = createModelSwitchNotice(notice({ historyTool: "read_agent_history" }));

        expect(text).toContain(
            "Use read_agent_history proactively whenever more detail could affect your answer.",
        );
        expect(text).toContain("The conversation itself is not part of this context");
        expect(text).not.toContain("Beginning history excerpt:");
    });

    it("renders a complete exact excerpt and tells the model when more history is available", () => {
        const text = createModelSwitchNotice(
            notice({ historyTool: "read_agent_history", excerpt: excerpt() }),
        );

        expect(text).toContain("History overview: 2 messages");
        expect(text).toContain("Beginning history excerpt:\n1. USER");
        expect(text).toContain("Recent history excerpt:\n2. ASSISTANT");
        expect(text).toContain(
            "then use read_agent_history proactively whenever the excerpt is incomplete",
        );
        expect(text).toContain("not raw provider protocol traffic or hidden reasoning");
    });

    it("labels sampled statistics as a bounded sample rather than archive totals", () => {
        const text = createModelSwitchNotice(
            notice({
                excerpt: excerpt({
                    statsAreSampled: true,
                }),
            }),
        );

        expect(text).toContain(
            "History sample overview (counts cover only the bounded excerpt, not the full archive)",
        );
        expect(text).not.toContain("\nHistory overview:");
    });

    it("omits the recent section when the beginning already covers the history", () => {
        const text = createModelSwitchNotice(
            notice({
                excerpt: excerpt({ recent: "" }),
            }),
        );

        expect(text).toContain("Beginning history excerpt:");
        expect(text).not.toContain("Recent history excerpt:");
    });

    it("preserves the configured provider identities even when display labels are supplied", () => {
        const text = createModelSwitchNotice(
            notice({
                previousModel: "A model with spaces",
                model: "Another model",
                previousProvider: "provider-A",
                provider: "provider-B",
            }),
        );

        expect(text).toContain("A model with spaces on provider-A");
        expect(text).toContain("Another model on provider-B");
    });
});

describe("createHistoryExcerpt", () => {
    it("keeps the earliest four and latest eight records in source order", () => {
        const records = Array.from({ length: 15 }, (_, position) => historyRecord(position));
        const result = createHistoryExcerpt(records, 32_000);

        expect(result.beginning).toContain("1. USER");
        expect(result.beginning).toContain("4. USER");
        expect(result.beginning).not.toContain("5. USER");
        expect(result.recent).toContain("8. USER");
        expect(result.recent).toContain("15. USER");
        expect(result.recent).not.toContain("7. USER");
        expect(result.statsAreSampled).toBe(true);
        expect(result.stats.messages).toBe(15);
    });

    it("uses an archive-wide aggregate when one is supplied", () => {
        const records = [historyRecord(0), historyRecord(1, "assistant")];
        const exactStats = {
            assistantMessages: 10,
            messages: 20,
            textCharacters: 300,
            thinkingBlocks: 4,
            toolCalls: 3,
            toolResults: 2,
            userMessages: 10,
        };

        const result = createHistoryExcerpt(records, 32_000, exactStats);

        expect(result.stats).toEqual(exactStats);
        expect(result.statsAreSampled).toBe(false);
    });

    it("bounds the combined excerpt output", () => {
        const records = Array.from({ length: 20 }, (_, position) =>
            historyRecord(position, "user", [{ type: "text", text: "x".repeat(5_000) }]),
        );

        const result = createHistoryExcerpt(records, 500);

        expect(result.beginning.length + result.recent.length).toBeLessThanOrEqual(500);
        expect(result.beginning.length).toBeGreaterThan(0);
        expect(result.recent.length).toBeGreaterThan(0);
    });

    it("caps each rendered message before the excerpt budget is applied", () => {
        const result = createHistoryExcerpt(
            [historyRecord(0, "user", [{ type: "text", text: "x".repeat(5_000) }])],
            32_000,
        );

        expect(result.beginning.length).toBeLessThan(1_600);
        expect(result.beginning).toContain("[truncated");
    });

    it("formats all supported history block kinds for the handoff", () => {
        const blocks: HistoryBlock[] = [
            { type: "text", text: "visible" },
            { type: "thinking", thinking: "reasoned", redacted: true },
            { type: "image", mediaType: "image/png" },
            { type: "tool_call", callId: "call-1", name: "lookup", arguments: { q: "x" } },
            {
                type: "tool_result",
                callId: "call-1",
                toolName: "lookup",
                display: "looked up",
                output: "result",
                isError: true,
            },
        ];

        const result = createHistoryExcerpt(
            [
                {
                    position: 0,
                    message: historyMessage(0, "assistant", blocks),
                },
            ],
            32_000,
        );

        expect(result.beginning).toContain("Text: visible");
        expect(result.beginning).toContain("Thinking: [redacted]");
        expect(result.beginning).toContain("[Image: image/png]");
        expect(result.beginning).toContain('Tool call: lookup {"q":"x"}');
        expect(result.beginning).toContain("Tool result: lookup (error)");
        expect(result.beginning).toContain("Output: result");
    });
});
