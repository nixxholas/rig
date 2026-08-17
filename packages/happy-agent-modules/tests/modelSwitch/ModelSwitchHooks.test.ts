import type { AgentBaseModelChange, AgentModel } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import { historyReaderSchema, type HistoryReader } from "../../sources/history/HistoryReader.js";
import type { HistoryRecord } from "../../sources/history/HistoryStore.js";
import {
    historyStatsSchema,
    summarizeHistory,
} from "../../sources/history/impl/summarizeHistory.js";
import {
    ModelSwitchModule,
    modelSwitchModuleOptionsSchema,
    type ModelSwitchModuleOptions,
} from "../../sources/modelSwitch/ModelSwitchModule.js";
import { modelSwitchScope } from "./modelSwitchTestSupport.js";
import {
    agentReference,
    historyRecord,
    modelChange,
    modelSwitchNoticeFromHook,
    readerFor,
} from "./modelSwitchTestSupport.js";

const ctx = createRootContext().named("happy-agent-modules-model-switch-hooks");

function model(providerId: string, id: string, name: string): AgentModel {
    return {
        providerId,
        id,
        name,
        effortLevels: ["low"],
        defaultEffort: "low",
    };
}

function textFromNotice(result: Awaited<ReturnType<typeof modelSwitchNoticeFromHook>>): string {
    if (result === undefined) throw new Error("Expected a model-switch notice.");
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Expected a text model-switch notice.");
    return block.text;
}

function readerWith(
    messages: HistoryReader["messages"],
    stats: HistoryReader["stats"] = async () => ({
        assistantMessages: 0,
        messages: 0,
        textCharacters: 0,
        thinkingBlocks: 0,
        toolCalls: 0,
        toolResults: 0,
        userMessages: 0,
    }),
): HistoryReader {
    return { messages, stats };
}

function moduleWithHistory(reader: HistoryReader): ModelSwitchModule {
    // The runtime reader contract is readonly, while the generated options schema currently
    // exposes `messages` as Promise<unknown[]>; keep this test focused on runtime behavior.
    const history = reader as unknown as NonNullable<ModelSwitchModuleOptions["history"]>;
    return new ModelSwitchModule({
        history,
    } as ModelSwitchModuleOptions);
}

describe("ModelSwitchModule options and lifecycle", () => {
    it("accepts empty options and rejects unknown or malformed options", () => {
        expect(Value.Check(modelSwitchModuleOptionsSchema, {})).toBe(true);
        expect(Value.Check(modelSwitchModuleOptionsSchema, { unexpected: true })).toBe(false);
        expect(
            Value.Check(modelSwitchModuleOptionsSchema, {
                history: { messages: "not a function", stats: async () => ({}) },
            }),
        ).toBe(false);

        expect(() => new ModelSwitchModule()).not.toThrow();
        expect(
            () =>
                new ModelSwitchModule({
                    unexpected: true,
                } as unknown as ModelSwitchModuleOptions),
        ).toThrow("Model switch module options are invalid.");
        expect(
            () =>
                new ModelSwitchModule({
                    history: {},
                } as unknown as ModelSwitchModuleOptions),
        ).toThrow("Model switch module options are invalid.");
    });

    it("validates a reader as a structural host seam without requiring a concrete HistoryModule", () => {
        const reader = readerFor([]);

        expect(Value.Check(historyReaderSchema, reader)).toBe(true);
        expect(() => moduleWithHistory(reader)).not.toThrow();
        expect(Value.Check(historyReaderSchema, { messages: vi.fn() })).toBe(false);
    });

    it("returns the modelChanged hook from beforeStart and uses the collection labels", async () => {
        const module = new ModelSwitchModule();
        const hooks = await module.beforeStart?.(
            ctx,
            agentReference([
                model("scripted", "openai/gpt-5.6-sol", "Fast OpenAI"),
                model("scripted", "anthropic/opus-5", "Careful Claude"),
            ]),
        );

        expect(hooks?.modelChanged).toBeTypeOf("function");
        const result = await hooks?.modelChanged?.(ctx, modelSwitchScope(), modelChange());
        const text = textFromNotice(result);

        expect(text).toContain("Fast OpenAI on scripted");
        expect(text).toContain("Careful Claude on scripted");
    });

    it("falls back to model IDs when the collection has no matching route", async () => {
        const module = new ModelSwitchModule();
        const result = await modelSwitchNoticeFromHook(module, ctx, {
            models: [model("other-provider", "openai/gpt-5.6-sol", "Wrong provider")],
        });

        const text = textFromNotice(result);
        expect(text).toContain("openai/gpt-5.6-sol on scripted");
        expect(text).toContain("anthropic/opus-5 on scripted");
        expect(text).not.toContain("Wrong provider");
    });

    it("does not emit for compatible changes or an initial model selection", async () => {
        const messages = vi.fn(async () => []);
        const module = moduleWithHistory(readerWith(messages));

        await expect(
            modelSwitchNoticeFromHook(module, ctx, {
                change: modelChange({ wasReset: false }),
            }),
        ).resolves.toBeUndefined();
        await expect(
            modelSwitchNoticeFromHook(module, ctx, {
                change: modelChange({ previousModel: undefined }),
            }),
        ).resolves.toBeUndefined();
        expect(messages).not.toHaveBeenCalled();
    });
});

describe("ModelSwitchModule history handoff", () => {
    it("reads both history ends concurrently and merges overlapping records once", async () => {
        const records = Array.from({ length: 6 }, (_, position) => historyRecord(position));
        let active = 0;
        let maximumActive = 0;
        const calls: string[] = [];
        const limits: number[] = [];
        const reader = readerWith(
            async (_ctx, _agentId, query) => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                calls.push(query.from ?? "default");
                limits.push(query.limit ?? 0);
                await Promise.resolve();
                active -= 1;
                return query.from === "end" ? records : records;
            },
            async () => summarizeHistory(records.map((record) => record.message)),
        );

        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
        const text = textFromNotice(result);

        expect(maximumActive).toBe(2);
        expect(calls.sort()).toEqual(["end", "start"]);
        expect(limits).toEqual([100, 100]);
        expect(text).toContain("History overview: 6 messages");
        expect(text.match(/1\. USER/g)).toHaveLength(1);
        expect(text.match(/6\. USER/g)).toHaveLength(1);
    });

    it("keeps a sampled overview when statistics are unavailable", async () => {
        const records = [historyRecord(0), historyRecord(1, "assistant")];
        const reader = readerWith(
            async () => records,
            async () => {
                throw new Error("stats unavailable");
            },
        );

        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
        const text = textFromNotice(result);

        expect(text).toContain(
            "History sample overview (counts cover only the bounded excerpt, not the full archive)",
        );
        expect(text).toContain("2 messages");
    });

    it("does not claim exact totals when supplied statistics undercount the sample", async () => {
        const records = [historyRecord(0), historyRecord(1, "assistant")];
        const reader = readerFor(records, records, {
            assistantMessages: 0,
            messages: 0,
            textCharacters: 0,
            thinkingBlocks: 0,
            toolCalls: 0,
            toolResults: 0,
            userMessages: 0,
        });

        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
        const text = textFromNotice(result);

        expect(text).toContain(
            "History sample overview (counts cover only the bounded excerpt, not the full archive)",
        );
        expect(text).not.toContain("\nHistory overview:");
    });

    it("accepts exact stats only when they are structurally and semantically valid", async () => {
        const records = [historyRecord(0), historyRecord(1, "assistant")];
        const exact = {
            assistantMessages: 10,
            messages: 20,
            textCharacters: 100,
            thinkingBlocks: 2,
            toolCalls: 3,
            toolResults: 4,
            userMessages: 10,
        };
        const reader = readerFor(records, records, exact);

        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
        const text = textFromNotice(result);

        expect(text).toContain("History overview: 20 messages");
        expect(text).not.toContain("History sample overview");
        expect(Value.Check(historyStatsSchema, exact)).toBe(true);
    });

    it("keeps a sampled excerpt, but never rejects the model switch, for malformed statistics", async () => {
        const records = [historyRecord(0)];
        const reader = readerWith(
            async () => records,
            async () => ({ malformed: true }) as never,
        );

        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
        const text = textFromNotice(result);

        expect(text).toContain(
            "The excerpt and tool expose the durable inference-oriented history",
        );
        expect(text).toContain("History sample overview");
    });

    it("drops only the excerpt when the history reader throws an arbitrary value", async () => {
        const hostile = {
            get message(): never {
                throw new Error("message getter should not be inspected");
            },
        };
        const reader = readerWith(async () => {
            throw hostile;
        });

        await expect(
            modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx),
        ).resolves.toBeDefined();
        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
        const text = textFromNotice(result);

        expect(text).toContain("The conversation itself is not part of this context");
        expect(text).not.toContain("Beginning history excerpt:");
    });

    it("drops the excerpt when one bounded page rejects", async () => {
        const records = [historyRecord(0)];
        const reader = readerWith(async (_ctx, _agentId, query) => {
            if (query.from === "end") throw new Error("end page failed");
            return records;
        });

        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
        const text = textFromNotice(result);

        expect(text).toContain("The conversation itself is not part of this context");
        expect(text).not.toContain("Beginning history excerpt:");
    });

    it("rejects malformed, unsorted, duplicate, and conflicting records fail-closed", async () => {
        const cases: readonly (readonly HistoryRecord[])[] = [
            [historyRecord(1), historyRecord(0)],
            [historyRecord(0), historyRecord(0, "assistant", undefined, { recordId: "other-id" })],
            [historyRecord(0), historyRecord(1, "assistant", undefined, { recordId: "record-0" })],
        ];

        for (const records of cases) {
            const reader = readerFor(records, records);
            const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);
            const text = textFromNotice(result);
            expect(text).not.toContain("Beginning history excerpt:");
        }

        const malformed = readerWith(async () => [{ nope: true }] as unknown as HistoryRecord[]);
        const malformedResult = await modelSwitchNoticeFromHook(moduleWithHistory(malformed), ctx);
        expect(textFromNotice(malformedResult)).not.toContain("Beginning history excerpt:");
    });

    it("rejects an overlapping record whose identity matches but whose payload changed", async () => {
        const reader = readerFor([historyRecord(0, "user")], [historyRecord(0, "assistant")]);

        const result = await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx);

        expect(textFromNotice(result)).not.toContain("Beginning history excerpt:");
    });

    it("rejects a reader page that exceeds the requested bounded limit", async () => {
        const records = Array.from({ length: 101 }, (_, position) => historyRecord(position));
        const result = await modelSwitchNoticeFromHook(
            moduleWithHistory(readerFor(records, records)),
            ctx,
        );

        expect(textFromNotice(result)).not.toContain("Beginning history excerpt:");
    });

    it("does not let two simultaneous handoffs interfere with one another", async () => {
        const records = [historyRecord(0), historyRecord(1)];
        const calls: string[] = [];
        const reader: HistoryReader = {
            messages: async (_ctx, _agentId, query) => {
                calls.push(query.from ?? "default");
                await Promise.resolve();
                return records;
            },
            stats: async () => summarizeHistory(records.map((record) => record.message)),
        };
        const module = moduleWithHistory(reader);

        const [first, second] = await Promise.all([
            modelSwitchNoticeFromHook(module, ctx),
            modelSwitchNoticeFromHook(module, ctx),
        ]);

        expect(textFromNotice(first)).toBe(textFromNotice(second));
        expect(calls).toHaveLength(4);
        expect(calls.filter((call) => call === "start")).toHaveLength(2);
        expect(calls.filter((call) => call === "end")).toHaveLength(2);
    });

    it("uses the requested agent identity for both history reads", async () => {
        const reader = readerFor([historyRecord(0)]);
        const agentIds: string[] = [];
        const trackingReader: HistoryReader = {
            messages: async (_ctx, agentId, query) => {
                agentIds.push(`${agentId}:${query.from}`);
                return reader.messages(_ctx, agentId, query);
            },
            stats: reader.stats,
        };
        const trackingModule = moduleWithHistory(trackingReader);

        await modelSwitchNoticeFromHook(trackingModule, ctx, {
            agentId: "target-agent",
        });

        expect(agentIds.sort()).toEqual(["target-agent:end", "target-agent:start"]);
    });
});

describe("ModelSwitchModule hook input boundaries", () => {
    it("does not mutate the caller's model change or history records", async () => {
        const records = [historyRecord(0), historyRecord(1)];
        const change: AgentBaseModelChange = modelChange();
        const changeSnapshot = { ...change };
        const reader = readerFor(records, records);
        const sourceSnapshot = JSON.stringify(records);

        await modelSwitchNoticeFromHook(moduleWithHistory(reader), ctx, {
            change,
        });

        expect(change).toEqual(changeSnapshot);
        expect(JSON.stringify(records)).toBe(sourceSnapshot);
    });

    it("does not require a history reader to explain an incompatible reset", async () => {
        const result = await modelSwitchNoticeFromHook(new ModelSwitchModule(), ctx, {
            change: modelChange({
                previousModel: "old",
                model: "new",
            }),
        });

        const text = textFromNotice(result);
        expect(text).toContain("old on scripted");
        expect(text).toContain("new on scripted");
        expect(text).toContain("Durable history lookup is unavailable");
    });

    it("keeps a valid notice when provider/model identifiers are empty only if the hook contract supplied them", async () => {
        const result = await modelSwitchNoticeFromHook(new ModelSwitchModule(), ctx, {
            change: modelChange({
                previousModel: "",
                model: "",
                previousProvider: "",
                provider: "",
            }),
        });

        expect(textFromNotice(result)).toContain("changed from  on  to  on");
    });
});
