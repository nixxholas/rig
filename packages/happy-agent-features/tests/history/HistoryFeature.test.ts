import { Type } from "@sinclair/typebox";
import { Agent, defineAgentTool, type AgentFeature } from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { formatHistoryPage, HistoryFeature } from "../../sources/index.js";
import { InMemoryHistoryStore } from "../support/InMemoryHistoryStore.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { providersOf, sharedKV, textTurn, toolCallTurn, user } from "../support/fixtures.js";

const ctx = createRootContext().named("happy-agent-features-history");

/** A tool that answers with whatever it was asked, so a run has tool activity to record. */
const echoTool = defineAgentTool({
    name: "echo",
    description: "Repeat the given text.",
    parameters: Type.Object({ text: Type.String() }),
    returnType: Type.Object({ text: Type.String() }),
    shouldReviewInAutoMode: () => false,
    execute: (_ctx, args) => Promise.resolve({ text: args.text }),
    toLLM: (result) => [{ type: "text", text: result.text }],
});

/** A tool that always fails, so a failed call has something to be recorded as. */
const failingTool = defineAgentTool({
    name: "fail",
    description: "Always fails.",
    parameters: Type.Object({}),
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => false,
    execute: () => Promise.reject(new Error("the tool gave up")),
    toLLM: () => [{ type: "text", text: "" }],
});

/** The one feature a test needs beyond history itself: something for the model to call. */
const toolsFeature: AgentFeature = {
    name: "test-tools",
    tools: () => [echoTool, failingTool],
};

/** An agent recording into a store a test can look inside. */
async function historyAgent(script: SessionEvent[][]) {
    const store = new InMemoryHistoryStore();
    const history = new HistoryFeature({ store });
    const agent = await Agent.create(ctx, {
        id: "history-agent",
        providers: providersOf(new ScriptedProvider(script)),
        provider: "scripted",
        model: "scripted/model",
        persistence: new InMemoryPersistence(),
        sharedKV: sharedKV(),
        features: [history, toolsFeature],
    });
    return { agent, history, store };
}

describe("HistoryFeature", () => {
    it("records what the agent said, called, and was told", async () => {
        const { agent, history, store } = await historyAgent([
            [
                { type: "reasoning_start" },
                { type: "reasoning_delta", delta: "thinking it over" },
                { type: "reasoning_end" },
                { type: "text_start" },
                { type: "text_delta", delta: "let me check" },
                { type: "text_end" },
                { type: "toolcall_start", callId: "call-1", name: "echo" },
                {
                    type: "toolcall_end",
                    callId: "call-1",
                    arguments: JSON.stringify({ text: "the answer" }),
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);

        await history.record(ctx, agent.id, {
            role: "user",
            blocks: [{ type: "text", text: "what is the answer" }],
        });
        await agent.send(ctx, user("what is the answer"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const recorded = store.messages.get(agent.id) ?? [];
        expect(recorded.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "assistant",
            "assistant",
        ]);
        expect(recorded[1]?.blocks).toEqual([
            { type: "thinking", thinking: "thinking it over" },
            { type: "text", text: "let me check" },
            {
                type: "tool_call",
                callId: "call-1",
                name: "echo",
                arguments: { text: "the answer" },
            },
        ]);
        expect(recorded[1]?.model).toBe("scripted/model");
        expect(recorded[2]?.blocks).toEqual([
            {
                type: "tool_result",
                callId: "call-1",
                toolName: "echo",
                output: "the answer",
            },
        ]);
    });

    it("records a failed tool call as the failure it was", async () => {
        const { agent, store } = await historyAgent([
            toolCallTurn("call-1", "fail", "{}"),
            textTurn("that did not work"),
        ]);

        await agent.send(ctx, user("try the failing tool"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const results = (store.messages.get(agent.id) ?? []).flatMap((message) =>
            message.blocks.filter((block) => block.type === "tool_result"),
        );
        expect(results).toEqual([
            {
                type: "tool_result",
                callId: "call-1",
                toolName: "fail",
                output: "the tool gave up",
                isError: true,
            },
        ]);
    });

    it("never lets a broken store fail the run", async () => {
        const { agent, store } = await historyAgent([textTurn("answered anyway")]);
        store.broken = true;

        await agent.send(ctx, user("say something"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(store.messages.size).toBe(0);
    });

    it("pages, searches, and renders what it recorded", async () => {
        const { agent, history } = await historyAgent([]);
        for (let index = 0; index < 12; index += 1) {
            await history.record(ctx, agent.id, {
                role: index % 2 === 0 ? "user" : "assistant",
                blocks: [{ type: "text", text: `MESSAGE_${index + 1}` }],
            });
        }
        await agent.close();

        const first = await history.read(ctx, agent.id, { limit: 5 });
        expect(first.totalMessages).toBe(12);
        expect(first.messages.map((record) => record.position)).toEqual([0, 1, 2, 3, 4]);
        expect(first.nextCursor).toBe(5);
        expect(first.previousCursor).toBeUndefined();

        const next = await history.read(ctx, agent.id, { cursor: first.nextCursor ?? 0, limit: 5 });
        expect(next.messages.map((record) => record.position)).toEqual([5, 6, 7, 8, 9]);
        expect(next.previousCursor).toBe(0);

        const last = await history.read(ctx, agent.id, { from: "end", limit: 3 });
        expect(last.messages.map((record) => record.position)).toEqual([9, 10, 11]);

        const searched = await history.read(ctx, agent.id, { query: "message_7" });
        expect(searched.matchedMessages).toBe(1);
        expect(formatHistoryPage(searched).history).toContain("7. USER");

        const users = await history.read(ctx, agent.id, { roles: ["user"] });
        expect(users.matchedMessages).toBe(6);
        expect(users.matchedStats.userMessages).toBe(6);
    });

    it("answers the model's own read through the tool", async () => {
        const { agent, history } = await historyAgent([]);
        await history.record(ctx, agent.id, {
            role: "user",
            blocks: [{ type: "text", text: "remember the port is 8080" }],
        });
        const tools = await Promise.all(
            [history].map((feature) => feature.tools(ctx, { agent: { id: agent.id } } as never)),
        );
        await agent.close();

        const tool = tools.flat()[0];
        if (tool === undefined) throw new Error("The feature offered no tool.");
        expect(tool.name).toBe("read_agent_history");
        const result = (await tool.execute(ctx, { query: "8080" })) as {
            history: string;
            matched_messages: number;
            total_messages: number;
        };
        expect(result.matched_messages).toBe(1);
        expect(result.total_messages).toBe(1);
        expect(result.history).toContain("remember the port is 8080");
    });
});
