import type {
    BaseSession,
    SessionCompaction,
    SessionEvent,
    SessionMessage,
    SessionStream,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    agentBaseEffort,
    agentBaseModel,
    agentBaseProvider,
    agentBaseServiceTier,
    AgentProviders,
    defineAgentTool,
} from "../sources/index.js";
import { providersOf, queued, system, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-base-test");

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

describe("AgentBase", () => {
    it("streams one inference from the provider session", async () => {
        const provider = new ScriptedProvider([textTurn("hello there")]);
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
            initialState: { instructions: "Be brief." },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events.filter((event) => event.type === "text_delta")).toHaveLength(11);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(provider.sessions).toHaveLength(1);
        const request = provider.sessions[0]?.requests[0];
        expect(request?.context.instructions).toBe("Be brief.");
        expect(request?.context.messages).toEqual([user("hi")]);
        await agent.close();
        expect(provider.sessions[0]?.destroyed).toBe(true);
    });

    it("reads mutated state on the next inference", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            [
                { type: "toolcall_start", callId: "call-1", name: "late_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("two"),
        ]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { instructions: "Original instructions." },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        let executed = false;
        agent.state.instructions = "Changed instructions.";
        agent.state.tools.push(
            defineAgentTool({
                name: "late_tool",
                returnType: Type.Object({}),
                execute: () => {
                    executed = true;
                    return Promise.resolve({});
                },
                toLLM: () => [],
            }),
        );
        await agent.send(ctx, user("second"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests[0]?.context.instructions).toBe("Original instructions.");
        expect(requests[1]?.context.instructions).toBe("Changed instructions.");
        // The tool added after construction executed for the later turn.
        expect(executed).toBe(true);
        expect(requests[2]?.context.messages.at(-1)).toMatchObject({ role: "tool" });
        await agent.close();
    });

    it("keeps a message sent during a run out of it and replays full history", async () => {
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        let agent: AgentBase;
        let sentSecond = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !sentSecond) {
                        sentSecond = true;
                        void agent.send(ctx, user("second"));
                    }
                },
            },
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.requests).toHaveLength(2);
        expect(session?.requests[0]?.context.messages).toEqual([user("first")]);
        expect(session?.requests[1]?.context.messages).toEqual([
            user("first"),
            { role: "assistant", content: [{ type: "text", text: "one" }] },
            user("second"),
        ]);
        await agent.close();
    });

    it("executes a tool call and feeds the result into the next inference", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "read_file" },
                { type: "toolcall_delta", callId: "call-1", delta: '{"path":' },
                { type: "toolcall_end", callId: "call-1", arguments: '{"path":"a.txt"}' },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done reading"),
        ]);
        const seen: string[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [
                defineAgentTool({
                    name: "read_file",
                    parameters: Type.Object({ path: Type.String() }),
                    returnType: Type.Object({ contents: Type.String() }),
                    execute: (_toolCtx, args) => {
                        // args is statically typed as { path: string } by the schema.
                        seen.push(args.path);
                        return Promise.resolve({ contents: "file contents" });
                    },
                    // result is statically typed as { contents: string } by the schema.
                    toLLM: (result) => [{ type: "text", text: result.contents }],
                }),
            ] },
        });

        await agent.send(ctx, user("read it"));
        await agent.waitForIdle();

        expect(seen).toEqual(["a.txt"]);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("read it"),
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: "call-1",
                        name: "read_file",
                        arguments: '{"path":"a.txt"}',
                    },
                ],
            },
            {
                role: "tool",
                callId: "call-1",
                content: [{ type: "text", text: "file contents" }],
            },
        ]);
        await agent.close();
    });

    it("runs tool calls in parallel and converts failures to error tool results", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-a", name: "slow_tool" },
                { type: "toolcall_end", callId: "call-a", arguments: "{}" },
                { type: "toolcall_start", callId: "call-b", name: "failing_tool" },
                { type: "toolcall_end", callId: "call-b", arguments: "{}" },
                { type: "toolcall_start", callId: "call-c", name: "missing_tool" },
                { type: "toolcall_end", callId: "call-c", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("all done"),
        ]);
        const finished: string[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [
                defineAgentTool({
                    name: "slow_tool",
                    returnType: Type.Object({ value: Type.String() }),
                    execute: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        finished.push("slow");
                        return { value: "slow result" };
                    },
                    toLLM: (result) => [{ type: "text", text: result.value }],
                }),
                defineAgentTool({
                    name: "failing_tool",
                    returnType: Type.Object({}),
                    execute: () => {
                        finished.push("failing");
                        return Promise.reject(new Error("tool blew up"));
                    },
                    toLLM: () => [],
                }),
            ] },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The quick tool settles before the slow one: they ran in parallel.
        expect(finished).toEqual(["failing", "slow"]);
        const nextRequest = provider.sessions[0]?.requests[1]?.context.messages;
        expect(nextRequest?.slice(-3)).toEqual([
            {
                role: "tool",
                callId: "call-a",
                content: [{ type: "text", text: "slow result" }],
            },
            {
                role: "tool",
                callId: "call-b",
                content: [{ type: "text", text: "tool blew up" }],
                isError: true,
            },
            {
                role: "tool",
                callId: "call-c",
                content: [{ type: "text", text: 'Tool "missing_tool" is not available.' }],
                isError: true,
            },
        ]);
        await agent.close();
    });

    it("rejects arguments that do not match the tool schema", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "read_file" },
                { type: "toolcall_end", callId: "call-1", arguments: '{"path":123}' },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("sorry"),
        ]);
        let executed = false;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [
                defineAgentTool({
                    name: "read_file",
                    parameters: Type.Object({ path: Type.String() }),
                    returnType: Type.Object({}),
                    execute: () => {
                        executed = true;
                        return Promise.resolve({});
                    },
                    toLLM: () => [],
                }),
            ] },
        });

        await agent.send(ctx, user("read it"));
        await agent.waitForIdle();

        expect(executed).toBe(false);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "call-1",
            content: [
                {
                    type: "text",
                    text: 'The arguments for "read_file" did not match its schema.',
                },
            ],
            isError: true,
        });
        await agent.close();
    });

    it("ignores server tool results while keeping the server call in the history", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "srv-1", name: "web_search", server: true },
                { type: "toolcall_end", callId: "srv-1", arguments: '{"query":"weather"}' },
                { type: "toolcall_result_start", callId: "srv-1" },
                { type: "toolcall_result_delta", callId: "srv-1", delta: "sunny" },
                {
                    type: "toolcall_result_end",
                    callId: "srv-1",
                    content: [{ type: "text", text: "sunny" }],
                },
                { type: "text_start" },
                { type: "text_delta", delta: "It is sunny." },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
        ]);
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("weather?"));
        await agent.waitForIdle();

        // The server call stays in the assistant message; its provider-settled result is
        // ignored — nothing executes, no tool result message joins the history, and the turn
        // needs no follow-up inference.
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(persistence.records).toEqual([
            { type: "user", message: user("weather?") },
            {
                type: "block",
                block: {
                    type: "tool_call",
                    callId: "srv-1",
                    name: "web_search",
                    arguments: '{"query":"weather"}',
                    server: true,
                },
            },
            { type: "block", block: { type: "text", text: "It is sunny." } },
        ]);
        // The result events still reach the hooks like every other stream event.
        expect(
            events.filter((event) => event.type.startsWith("toolcall_result")),
        ).toHaveLength(3);
        await agent.close();
    });

    it("fails the turn when the provider ID is not registered", async () => {
        const persistence = new InMemoryPersistence();
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: new AgentProviders(),
            provider: "missing",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: 'Provider "missing" is not registered.',
            },
        ]);
        expect(persistence.records.at(-1)).toMatchObject({ type: "system" });
        await agent.close();
    });

    it("reports a thrown provider failure as an error done event", async () => {
        class FailingProvider extends ScriptedProvider {
            override session(): Promise<BaseSession> {
                return Promise.reject(new Error("no credentials"));
            }
        }
        const provider = new FailingProvider([]);
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "no credentials",
            },
        ]);
        await agent.close();
    });
});

describe("AgentBase persistence", () => {
    it("loads stored history on the first inference attempt only", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("earlier question") },
            { type: "block", block: { type: "text", text: "earlier " } },
            { type: "block", block: { type: "text", text: "answer" } },
        ]);
        const provider = new ScriptedProvider([textTurn("fresh"), textTurn("again")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();
        await agent.send(ctx, user("more"));
        await agent.waitForIdle();

        expect(persistence.loads).toBe(1);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("earlier question"),
            {
                role: "assistant",
                content: [
                    { type: "text", text: "earlier " },
                    { type: "text", text: "answer" },
                ],
            },
            user("hi"),
        ]);
        await agent.close();
    });

    it("appends a record for the user message and each finished block", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "reasoning_start" },
                { type: "reasoning_delta", delta: "hmm" },
                { type: "reasoning_end", reasoning: "opaque" },
                { type: "text_start" },
                { type: "text_delta", delta: "sure" },
                { type: "text_end" },
                { type: "toolcall_start", callId: "call-1", name: "read_file" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("ok"),
        ]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [
                defineAgentTool({
                    name: "read_file",
                    returnType: Type.Object({ contents: Type.String() }),
                    execute: () => Promise.resolve({ contents: "contents" }),
                    toLLM: (result) => [{ type: "text", text: result.contents }],
                }),
            ] },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.records).toEqual([
            { type: "user", message: user("go") },
            {
                type: "block",
                block: { type: "reasoning", text: "hmm", reasoning: "opaque" },
            },
            { type: "block", block: { type: "text", text: "sure" } },
            {
                type: "block",
                block: {
                    type: "tool_call",
                    callId: "call-1",
                    name: "read_file",
                    arguments: "{}",
                },
            },
            {
                type: "tool",
                message: {
                    role: "tool",
                    callId: "call-1",
                    content: [{ type: "text", text: "contents" }],
                },
            },
            { type: "block", block: { type: "text", text: "ok" } },
        ]);
        expect(persistence.values.size).toBe(0);
        await agent.close();
    });

    it("reassembles a turn split by a mid-turn user record", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "part one" },
                { type: "text_end" },
                { type: "text_start" },
                { type: "text_delta", delta: "part two" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
            textTurn("noted"),
        ]);
        let agent: AgentBase;
        let sentMid = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    // Interleave a user write between the turn's two block records.
                    if (event.type === "text_delta" && event.delta === "part two" && !sentMid) {
                        sentMid = true;
                        void agent.send(ctx, user("mid-turn"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const kinds = persistence.records.map((record) =>
            record.type === "user" ? "user" : "block",
        );
        // The mid-turn message waits under its pending key, so the first turn's two block
        // records stay contiguous; it enters the main store only when the follow-up turn
        // consumes it, ahead of that turn's block.
        expect(kinds).toEqual(["user", "block", "block", "user", "block"]);
        expect(persistence.values.size).toBe(0);

        const reloadedProvider = new ScriptedProvider([textTurn("hello again")]);
        const reloaded = new AgentBase(ctx, {
            id: "test-agent-reloaded",
            providers: providersOf(reloadedProvider),
            provider: "scripted",
            persistence,
        });
        await reloaded.send(ctx, user("back"));
        await reloaded.waitForIdle();

        expect(reloadedProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("go"),
            {
                role: "assistant",
                content: [
                    { type: "text", text: "part one" },
                    { type: "text", text: "part two" },
                ],
            },
            user("mid-turn"),
            { role: "assistant", content: [{ type: "text", text: "noted" }] },
            user("back"),
        ]);
        await reloaded.close();
        await agent.close();
    });

    it("resolves send once the message is persisted, before the turn ends", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("slow reply")]);
        let done = false;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "done") done = true;
                },
            },
        });

        await agent.send(ctx, user("hi"));

        // The message is durably stored the moment send resolves: still under its pending
        // key, or already consumed into the main store if the turn got that far.
        const persisted = [
            ...[...persistence.values.values()].map(
                (value) => (value as { message: unknown }).message,
            ),
            ...persistence.records
                .filter((record) => record.type === "user")
                .map((record) => record.message),
        ];
        expect(persisted).toEqual([user("hi")]);
        expect(done).toBe(false);
        await agent.waitForIdle();
        expect(done).toBe(true);
        await agent.close();
    });

    it("serializes concurrent sends so storage and replay order match", async () => {
        const persistence = new InMemoryPersistence();
        const write = persistence.writeValue.bind(persistence);
        persistence.writeValue = async (writeCtx, key, value) => {
            // The first write is slow; without the lock the second would land first.
            const { message } = value as ReturnType<typeof queued>;
            if (message.content[0]?.type === "text" && message.content[0].text === "first") {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await write(writeCtx, key, value);
        };
        const provider = new ScriptedProvider([textTurn("reply")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sendMode: "all",
        });

        await Promise.all([
            agent.send(ctx, user("first")),
            agent.send(ctx, user("second")),
        ]);
        await agent.waitForIdle();

        expect(
            persistence.records
                .filter((record) => record.type === "user")
                .map((record) => record.message),
        ).toEqual([user("first"), user("second")]);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("first"),
            user("second"),
        ]);
        await agent.close();
    });

    it("keeps a message whose write failed out of the conversation", async () => {
        const persistence = new InMemoryPersistence();
        persistence.writeValue = () => Promise.reject(new Error("disk full"));
        const provider = new ScriptedProvider([textTurn("never")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await expect(agent.send(ctx, user("hi"))).rejects.toThrow("disk full");
        await agent.waitForIdle();

        expect(persistence.records).toEqual([]);
        expect(persistence.values.size).toBe(0);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });

    it("rolls the whole pending consumption back when one operation fails", async () => {
        const persistence = new InMemoryPersistence();
        persistence.deleteValue = () => Promise.reject(new Error("delete failed"));
        const provider = new ScriptedProvider([textTurn("never")]);
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "delete failed",
            },
        ]);
        // The append inside the transaction must not survive the failed delete: the message
        // stays pending only, ready for the next attempt. The failed turn itself surfaces as
        // a system record.
        expect(persistence.records).toEqual([
            {
                type: "system",
                message: {
                    role: "system",
                    content: [{ type: "text", text: "The last turn failed: delete failed" }],
                },
            },
        ]);
        expect([...persistence.values.values()]).toEqual([queued(user("hi"))]);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });

    it("reports a failing load as an error done event while send still persists", async () => {
        const persistence = new InMemoryPersistence();
        persistence.load = () => Promise.reject(new Error("storage offline"));
        const provider = new ScriptedProvider([textTurn("never")]);
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "storage offline",
            },
        ]);
        // The load failed before any turn could consume the message, so it is still waiting
        // under its pending key rather than in the main context store.
        expect(persistence.records).toEqual([]);
        expect([...persistence.values.values()]).toEqual([queued(user("hi"))]);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });

    it("commits the tool batch to storage first and lands results in call order", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-a", name: "slow_tool" },
                { type: "toolcall_end", callId: "call-a", arguments: "{}" },
                { type: "toolcall_start", callId: "call-b", name: "fast_tool" },
                { type: "toolcall_end", callId: "call-b", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        let keysDuringFast: string[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [
                defineAgentTool({
                    name: "slow_tool",
                    returnType: Type.Object({ value: Type.String() }),
                    execute: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        return { value: "slow" };
                    },
                    toLLM: (result) => [{ type: "text", text: result.value }],
                }),
                defineAgentTool({
                    name: "fast_tool",
                    returnType: Type.Object({ value: Type.String() }),
                    execute: () => {
                        // Both calls are already durable in the sorted store while running.
                        keysDuringFast = [...persistence.values.keys()].filter((key) =>
                            key.startsWith("tool."),
                        );
                        return Promise.resolve({ value: "fast" });
                    },
                    toLLM: (result) => [{ type: "text", text: result.value }],
                }),
            ] },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(keysDuringFast).toEqual(["tool.000000.call-a", "tool.000001.call-b"]);
        // The fast tool finished first, but its result waited for the earlier call to commit.
        expect(
            persistence.records
                .filter((record) => record.type === "tool")
                .map((record) => record.message.callId),
        ).toEqual(["call-a", "call-b"]);
        expect(persistence.values.size).toBe(0);
        await agent.close();
    });

    it("start resumes an interrupted tool batch, retrying only durable tools", async () => {
        const durableCall = {
            type: "tool_call" as const,
            callId: "call-a",
            name: "durable_tool",
            arguments: "{}",
        };
        const fragileCall = {
            type: "tool_call" as const,
            callId: "call-b",
            name: "fragile_tool",
            arguments: "{}",
        };
        // The crash happened after the batch was committed but before any result landed.
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("go") },
            { type: "block", block: durableCall },
            { type: "block", block: fragileCall },
        ]);
        persistence.values.set("tool.000000.call-a", durableCall);
        persistence.values.set("tool.000001.call-b", fragileCall);
        const provider = new ScriptedProvider([textTurn("recovered")]);
        let durableRuns = 0;
        let fragileRuns = 0;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [
                defineAgentTool({
                    name: "durable_tool",
                    durable: true,
                    returnType: Type.Object({ value: Type.String() }),
                    execute: () => {
                        durableRuns += 1;
                        return Promise.resolve({ value: "retried result" });
                    },
                    toLLM: (result) => [{ type: "text", text: result.value }],
                }),
                defineAgentTool({
                    name: "fragile_tool",
                    returnType: Type.Object({}),
                    execute: () => {
                        fragileRuns += 1;
                        return Promise.resolve({});
                    },
                    toLLM: () => [],
                }),
            ] },
        });

        agent.start();
        await agent.waitForIdle();

        expect(durableRuns).toBe(1);
        expect(fragileRuns).toBe(0);
        expect(persistence.records.slice(-3)).toEqual([
            {
                type: "tool",
                message: {
                    role: "tool",
                    callId: "call-a",
                    content: [{ type: "text", text: "retried result" }],
                },
            },
            {
                type: "tool",
                message: {
                    role: "tool",
                    callId: "call-b",
                    content: [
                        {
                            type: "text",
                            text: "The tool call was interrupted by a restart and was not retried.",
                        },
                    ],
                    isError: true,
                },
            },
            { type: "block", block: { type: "text", text: "recovered" } },
        ]);
        expect(persistence.values.size).toBe(0);
        // The follow-up inference saw the full context: call blocks then both results.
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("go"),
            { role: "assistant", content: [durableCall, fragileCall] },
            {
                role: "tool",
                callId: "call-a",
                content: [{ type: "text", text: "retried result" }],
            },
            {
                role: "tool",
                callId: "call-b",
                content: [
                    {
                        type: "text",
                        text: "The tool call was interrupted by a restart and was not retried.",
                    },
                ],
                isError: true,
            },
        ]);
        await agent.close();
    });

    it("start finishes a turn cut off before the assistant replied", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("still waiting") },
        ]);
        const provider = new ScriptedProvider([textTurn("here now")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("still waiting"),
        ]);
        expect(persistence.records.at(-1)).toEqual({
            type: "block",
            block: { type: "text", text: "here now" },
        });
        await agent.close();
    });

    it("start consumes a message left pending by a crash", async () => {
        const persistence = new InMemoryPersistence();
        persistence.values.set("send.00000000000001.000000", queued(user("lost send")));
        const provider = new ScriptedProvider([textTurn("caught up")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(persistence.records).toEqual([
            { type: "user", message: user("lost send") },
            { type: "block", block: { type: "text", text: "caught up" } },
        ]);
        expect(persistence.values.size).toBe(0);
        await agent.close();
    });

    it("abort cancels a hanging stream, keeps finished blocks, and closes the stream", async () => {
        const persistence = new InMemoryPersistence();
        let releaseHang = (): void => undefined;
        const hang = new Promise<void>((resolve) => {
            releaseHang = resolve;
        });
        class HangingProvider extends ScriptedProvider {
            streamClosed = false;
            override async session(id: string, options: never): Promise<BaseSession> {
                const session = (await super.session(id, options)) as ScriptedSession;
                const run = session.run.bind(session);
                const self = this;
                session.run = (runCtx, request): SessionStream => {
                    const scripted = run(runCtx, request);
                    return (async function* () {
                        try {
                            yield* scripted;
                            // The provider stalls here until the test releases it.
                            await hang;
                            yield { type: "text_delta", delta: "late" } as SessionEvent;
                        } finally {
                            self.streamClosed = true;
                        }
                    })();
                };
                return session;
            }
        }
        const provider = new HangingProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "finished" },
                { type: "text_end" },
                { type: "text_start" },
                { type: "text_delta", delta: "partial" },
            ],
        ]);
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("go"));
        await until(() =>
            events.some((event) => event.type === "text_delta" && event.delta === "partial"),
        );
        await agent.abort();

        expect(events.at(-1)).toEqual({ type: "done", state: "cancelled" });
        // Once the stalled await settles, the requested stream closure runs its finally, and
        // the event the provider produced after the abort never reaches the hooks.
        releaseHang();
        await until(() => provider.streamClosed);
        expect(events.some((event) => event.type === "text_delta" && event.delta === "late")).toBe(
            false,
        );
        // Only the finished block survives; the unfinished one is dropped everywhere.
        expect(persistence.records).toEqual([
            { type: "user", message: user("go") },
            { type: "block", block: { type: "text", text: "finished" } },
        ]);
        await agent.close();

        const reloadedProvider = new ScriptedProvider([textTurn("next reply")]);
        const reloaded = new AgentBase(ctx, {
            id: "test-agent-reloaded",
            providers: providersOf(reloadedProvider),
            provider: "scripted",
            persistence,
        });
        await reloaded.send(ctx, user("next"));
        await reloaded.waitForIdle();
        expect(reloadedProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("go"),
            { role: "assistant", content: [{ type: "text", text: "finished" }] },
            user("next"),
        ]);
        await reloaded.close();
    });

    it("abort settles a hanging tool as an aborted error result without a follow-up turn", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "hang_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("never"),
        ]);
        let started = false;
        let lifetime: AbortSignal | undefined;
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
            initialState: { tools: [
                defineAgentTool({
                    name: "hang_tool",
                    returnType: Type.Object({}),
                    execute: (toolCtx) => {
                        started = true;
                        lifetime = toolCtx.lifetime;
                        return new Promise<never>(() => undefined);
                    },
                    toLLM: () => [],
                }),
            ] },
        });

        await agent.send(ctx, user("go"));
        await until(() => started);
        expect(lifetime?.aborted).toBe(false);
        await agent.abort();
        // The running tool observed the cancellation through its context lifetime.
        expect(lifetime?.aborted).toBe(true);

        expect(persistence.records.at(-1)).toEqual({
            type: "tool",
            message: {
                role: "tool",
                callId: "call-1",
                content: [{ type: "text", text: "The tool call was aborted." }],
                isError: true,
            },
        });
        // The pending entry was consumed by the aborted result, not left for a restart.
        expect(persistence.values.size).toBe(0);
        expect(events.at(-1)).toEqual({ type: "done", state: "cancelled" });
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("abort is a no-op when idle and the agent keeps working afterwards", async () => {
        const provider = new ScriptedProvider([textTurn("still fine")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.abort();
        await agent.send(ctx, user("hi"));
        await agent.waitForIdle();
        await agent.abort();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("start on an idle history loads without running inference", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("hi") },
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([textTurn("never")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(persistence.loads).toBe(1);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });
});

describe("AgentBase per-message settings", () => {
    it("applies settings carried by a message and keeps them for later messages", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "anthropic/default",
        });

        await agent.send(ctx, user("switch"), {
            model: "anthropic/better",
            effort: "high",
            serviceTier: "priority",
        });
        await agent.waitForIdle();
        await agent.send(ctx, user("plain"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.requests[0]).toMatchObject({
            model: "anthropic/better",
            effort: "high",
            serviceTier: "priority",
        });
        // The next message carried nothing, so the previous settings stay effective.
        expect(session?.requests[1]).toMatchObject({
            model: "anthropic/better",
            effort: "high",
            serviceTier: "priority",
        });
        // The agent context reflects the currently effective settings.
        const secondContext = session?.requestContexts[1];
        expect(secondContext).toBeDefined();
        if (secondContext !== undefined) {
            expect(agentBaseModel(secondContext)).toBe("anthropic/better");
            expect(agentBaseEffort(secondContext)).toBe("high");
            expect(agentBaseServiceTier(secondContext)).toBe("priority");
        }
        await agent.close();
    });

    it("resets on an incompatible model change: erases history, destroys the session, and lets the hook seed the fresh context", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("claude says"), textTurn("gpt says")]);
        const providers = providersOf(provider);
        const changes: unknown[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers,
            provider: "scripted",
            persistence,
            model: "anthropic/claude",
            hooks: {
                modelChanged: (_hookCtx, change) => {
                    changes.push(change);
                    return system("Summary of the previous conversation.");
                },
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        expect(changes).toEqual([
            {
                previousModel: "anthropic/claude",
                model: "openai/gpt",
                previousProvider: "scripted",
                provider: "scripted",
                providers,
                previousProviderInstance: provider,
                providerInstance: provider,
                wasReset: true,
            },
        ]);
        // The old session is gone and a fresh one serves the new model.
        expect(provider.sessions[0]?.destroyed).toBe(true);
        expect(provider.sessions).toHaveLength(2);
        // The fresh context starts with the injected message; everything earlier is erased,
        // durably too.
        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            system("Summary of the previous conversation."),
            user("switch"),
        ]);
        expect(persistence.records).toEqual([
            { type: "system", message: system("Summary of the previous conversation.") },
            { type: "user", message: user("switch") },
            { type: "block", block: { type: "text", text: "gpt says" } },
        ]);
        await agent.close();
    });

    it("starts the fresh context completely empty when no hook injects a message", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "anthropic/claude",
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([user("switch")]);
        await agent.close();
    });

    it("keeps the history and the session on a compatible model change", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const changes: unknown[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            model: "anthropic/claude-a",
            persistence: new InMemoryPersistence(),
            hooks: {
                modelChanged: (_hookCtx, change) => {
                    changes.push(change);
                    // Ignored on a compatible change: no reset happened.
                    return system("should not appear");
                },
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "anthropic/claude-b" });
        await agent.waitForIdle();

        expect(changes).toEqual([
            expect.objectContaining({
                previousModel: "anthropic/claude-a",
                model: "anthropic/claude-b",
                wasReset: false,
            }),
        ]);
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.destroyed).toBe(false);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("hello"),
            { role: "assistant", content: [{ type: "text", text: "first" }] },
            user("switch"),
        ]);
        await agent.close();
    });

    it("switches provider compatibly: history kept, fresh session on the new provider", async () => {
        const claudeProvider = new ScriptedProvider([textTurn("from claude")]);
        const bedrockProvider = new ScriptedProvider([textTurn("from bedrock")]);
        const providers = new AgentProviders();
        providers.add("claude", claudeProvider, "claude");
        providers.add("bedrock", bedrockProvider, "bedrock");
        const changes: unknown[] = [];
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers,
            provider: "claude",
            model: "anthropic/claude-x",
            persistence: new InMemoryPersistence(),
            hooks: {
                modelChanged: (_hookCtx, change) => {
                    changes.push(change);
                    return system("should not appear");
                },
            },
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { provider: "bedrock" });
        await agent.waitForIdle();

        // A claude-family model may move from a claude provider to a bedrock provider without
        // a reset, but the session is provider-bound, so the old one is destroyed and the new
        // provider serves the kept history.
        expect(changes).toEqual([
            {
                previousModel: "anthropic/claude-x",
                model: "anthropic/claude-x",
                previousProvider: "claude",
                provider: "bedrock",
                providers,
                previousProviderInstance: claudeProvider,
                providerInstance: bedrockProvider,
                wasReset: false,
            },
        ]);
        expect(claudeProvider.sessions[0]?.destroyed).toBe(true);
        expect(bedrockProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("hello"),
            { role: "assistant", content: [{ type: "text", text: "from claude" }] },
            user("switch"),
        ]);
        await agent.close();
    });

    it("resets when switching to a different provider of the same type", async () => {
        const firstProvider = new ScriptedProvider([textTurn("first")]);
        const secondProvider = new ScriptedProvider([textTurn("second")]);
        const providers = new AgentProviders();
        providers.add("claude-a", firstProvider, "claude");
        providers.add("claude-b", secondProvider, "claude");
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers,
            provider: "claude-a",
            model: "anthropic/claude-x",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { provider: "claude-b" });
        await agent.waitForIdle();

        // Same compatibility type but a different registry entry — for example another
        // credential — cannot continue the conversation.
        expect(firstProvider.sessions[0]?.destroyed).toBe(true);
        expect(secondProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("switch"),
        ]);
        await agent.close();
    });

    it("keeps the effective provider across a restart", async () => {
        const persistence = new InMemoryPersistence();
        const claudeProvider = new ScriptedProvider([textTurn("from claude")]);
        const bedrockProvider = new ScriptedProvider([textTurn("from bedrock")]);
        const makeProviders = (
            claude: ScriptedProvider,
            bedrock: ScriptedProvider,
        ): AgentProviders => {
            const providers = new AgentProviders();
            providers.add("claude", claude, "claude");
            providers.add("bedrock", bedrock, "bedrock");
            return providers;
        };
        const firstAgent = new AgentBase(ctx, {
            id: "provider-restart",
            providers: makeProviders(claudeProvider, bedrockProvider),
            provider: "claude",
            model: "anthropic/claude-x",
            persistence,
        });
        await firstAgent.send(ctx, user("switch"), { provider: "bedrock" });
        await firstAgent.waitForIdle();
        await firstAgent.close();

        const laterClaude = new ScriptedProvider([textTurn("unused")]);
        const laterBedrock = new ScriptedProvider([textTurn("still bedrock")]);
        const secondAgent = new AgentBase(ctx, {
            id: "provider-restart",
            providers: makeProviders(laterClaude, laterBedrock),
            provider: "claude",
            model: "anthropic/claude-x",
            persistence,
        });
        await secondAgent.send(ctx, user("plain"));
        await secondAgent.waitForIdle();

        // The durable settings restored the provider switch; the constructor default did not
        // pull the conversation back to the claude provider.
        expect(laterClaude.sessions).toHaveLength(0);
        expect(laterBedrock.sessions[0]?.requests).toHaveLength(1);
        await secondAgent.close();
    });

    it("keeps the effective settings across a restart", async () => {
        const persistence = new InMemoryPersistence();
        const firstProvider = new ScriptedProvider([textTurn("first")]);
        const firstAgent = new AgentBase(ctx, {
            id: "settings-restart",
            providers: providersOf(firstProvider),
            provider: "scripted",
            persistence,
            model: "anthropic/default",
        });
        await firstAgent.send(ctx, user("switch"), { model: "anthropic/better" });
        await firstAgent.waitForIdle();
        await firstAgent.close();

        const secondProvider = new ScriptedProvider([textTurn("second")]);
        const secondAgent = new AgentBase(ctx, {
            id: "settings-restart",
            providers: providersOf(secondProvider),
            provider: "scripted",
            persistence,
            model: "anthropic/default",
        });
        await secondAgent.send(ctx, user("plain"));
        await secondAgent.waitForIdle();

        // The previously effective model survived the restart through the durable settings.
        expect(secondProvider.sessions[0]?.requests[0]).toMatchObject({
            model: "anthropic/better",
        });
        await secondAgent.close();
    });
});

describe("AgentBase message delivery strategies", () => {
    it("steering while idle triggers a new turn on its own", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answered")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.steer(ctx, user("just steering"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("just steering"),
        ]);
        expect(persistence.records).toEqual([
            { type: "user", message: user("just steering") },
            { type: "block", block: { type: "text", text: "answered" } },
        ]);
        expect(persistence.values.size).toBe(0);
        await agent.close();
    });

    it("steering one-at-a-time answers each queued steering message separately", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        let agent: AgentBase;
        let queued = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.steer(ctx, user("steer one"));
                        void agent.steer(ctx, user("steer two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("steer one"));
        expect(requests[1]?.context.messages).not.toContainEqual(user("steer two"));
        expect(requests[2]?.context.messages.at(-1)).toEqual(user("steer two"));
        expect(requests[2]?.context.messages.at(-2)).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "two" }],
        });
        await agent.close();
    });

    it("steering all injects every queued steering message before one response", async () => {
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        let agent: AgentBase;
        let queued = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            steeringMode: "all",
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.steer(ctx, user("steer one"));
                        void agent.steer(ctx, user("steer two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("steer one"),
            user("steer two"),
        ]);
        await agent.close();
    });

    it("follow-up one-at-a-time waits for each response before draining the next", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        let agent: AgentBase;
        let queued = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.send(ctx, user("follow one"));
                        void agent.send(ctx, user("follow two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("follow one"));
        expect(requests[1]?.context.messages).not.toContainEqual(user("follow two"));
        expect(requests[2]?.context.messages.at(-1)).toEqual(user("follow two"));
        await agent.close();
    });

    it("follow-up all injects every queued follow-up before one response", async () => {
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        let agent: AgentBase;
        let queued = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sendMode: "all",
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.send(ctx, user("follow one"));
                        void agent.send(ctx, user("follow two"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("follow one"),
            user("follow two"),
        ]);
        await agent.close();
    });

    it("steering takes precedence over an earlier follow-up", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        let agent: AgentBase;
        let queued = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        // The follow-up is queued first, but steering still injects first.
                        void agent.send(ctx, user("the follow-up"));
                        void agent.steer(ctx, user("the steering"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("the steering"));
        expect(requests[2]?.context.messages.at(-1)).toEqual(user("the follow-up"));
        expect(
            persistence.records
                .filter((record) => record.type === "user")
                .map((record) => record.message),
        ).toEqual([user("go"), user("the steering"), user("the follow-up")]);
        await agent.close();
    });

    it("steering injects after the tool batch finishes, before the next inference", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "lookup" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("answered"),
        ]);
        let agent: AgentBase;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [
                defineAgentTool({
                    name: "lookup",
                    returnType: Type.Object({ value: Type.String() }),
                    execute: () => Promise.resolve({ value: "found" }),
                    toLLM: (result) => [{ type: "text", text: result.value }],
                }),
            ] },
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "toolcall_start") {
                        void agent.steer(ctx, user("mid-tools steering"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The steering message rides into the same request as the tool result: injected after
        // the batch finished but before the follow-up inference for its results.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            {
                role: "tool",
                callId: "call-1",
                content: [{ type: "text", text: "found" }],
            },
            user("mid-tools steering"),
        ]);
        await agent.close();
    });
});

describe("AgentBase compaction", () => {
    const compactionMessage: SessionMessage = {
        role: "compaction",
        content: "summary of everything so far",
        encryptedContent: null,
    };
    const completed = (messages: SessionMessage[]): SessionCompaction => ({
        status: "completed",
        preservedMessages: [],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        context: { instructions: "", messages },
    });

    it("waits for the active turn to end, then replaces the compacted history", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "slow_tool" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("turn finished"),
            textTurn("next reply"),
        ]);
        let started = false;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "slow_tool",
                        returnType: Type.Object({}),
                        execute: async () => {
                            started = true;
                            await new Promise((resolve) => setTimeout(resolve, 20));
                            return {};
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await until(() => started);
        const session = provider.sessions[0];
        if (session !== undefined) {
            session.compactionResults = [completed([compactionMessage, user("go")])];
        }
        const compaction = agent.compact(ctx);
        await compaction;

        // The compaction saw the complete finished turn, not the mid-turn state.
        expect(session?.compactions).toHaveLength(1);
        expect(session?.compactions[0]?.context.messages).toHaveLength(4);
        expect(session?.compactions[0]?.context.messages.at(-1)).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "turn finished" }],
        });
        // The superseded records are physically gone; the store holds only the replacement.
        expect(persistence.records).toEqual([
            {
                type: "compaction",
                messages: [compactionMessage, user("go")],
            },
        ]);

        await agent.send(ctx, user("after compaction"));
        await agent.waitForIdle();
        expect(session?.requests.at(-1)?.context.messages).toEqual([
            compactionMessage,
            user("go"),
            user("after compaction"),
        ]);
        await agent.close();
    });

    it("compacts an idle agent without running inference", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("hi") },
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });
        // Prime the session with the scripted compaction before the first pass creates it.
        const primed = new Promise<void>((resolve) => {
            const original = provider.session.bind(provider);
            provider.session = async (id, options) => {
                const session = await original(id, options);
                (session as ScriptedSession).compactionResults = [
                    completed([compactionMessage]),
                ];
                resolve();
                return session;
            };
        });

        await agent.compact(ctx);
        await primed;

        expect(provider.sessions[0]?.requests).toHaveLength(0);
        expect(provider.sessions[0]?.compactions[0]?.context.messages).toEqual([
            user("hi"),
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ]);
        expect(persistence.records.at(-1)).toEqual({
            type: "compaction",
            messages: [compactionMessage],
        });
        await agent.close();
    });

    it("shares one compaction between parallel compact calls", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("hi") },
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await Promise.all([agent.compact(ctx), agent.compact(ctx), agent.compact(ctx)]);

        expect(provider.sessions[0]?.compactions).toHaveLength(1);
        expect(
            persistence.records.filter((record) => record.type === "compaction"),
        ).toHaveLength(1);
        await agent.close();
    });

    it("rejects every waiter when the provider reports a failed compaction", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("hi") },
            { type: "block", block: { type: "text", text: "hello" } },
        ]);
        const provider = new ScriptedProvider([textTurn("still works")]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [
                { status: "failed", kind: "inference_error", message: "model unavailable" },
            ];
            return session;
        };
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        const first = agent.compact(ctx);
        const second = agent.compact(ctx);
        await expect(first).rejects.toThrow("model unavailable");
        await expect(second).rejects.toThrow("model unavailable");

        // The history is untouched and the agent keeps working.
        expect(
            persistence.records.filter((record) => record.type === "compaction"),
        ).toHaveLength(0);
        await agent.send(ctx, user("still there?"));
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("hi"),
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
            user("still there?"),
        ]);
        await agent.close();
    });

    it("rolls the deletion back when the compaction record fails to write", async () => {
        const records = [
            { type: "user" as const, message: user("hi") },
            { type: "block" as const, block: { type: "text" as const, text: "hello" } },
        ];
        const persistence = new InMemoryPersistence([...records]);
        const originalAppend = persistence.append.bind(persistence);
        persistence.append = async (appendContext, record) => {
            if (record.type === "compaction") throw new Error("disk full");
            await originalAppend(appendContext, record);
        };
        const provider = new ScriptedProvider([]);
        const original = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = await original(id, options);
            (session as ScriptedSession).compactionResults = [completed([compactionMessage])];
            return session;
        };
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await expect(agent.compact(ctx)).rejects.toThrow("disk full");

        // The clear and the replacement write commit together or not at all.
        expect(persistence.records).toEqual(records);
        await agent.close();
    });

    it("replays the compacted context after a reload", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("old question") },
            { type: "block", block: { type: "text", text: "old answer" } },
            { type: "compaction", messages: [compactionMessage, user("kept message")] },
            { type: "user", message: user("newer question") },
            { type: "block", block: { type: "text", text: "newer answer" } },
        ]);
        const provider = new ScriptedProvider([textTurn("reply")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("latest"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            compactionMessage,
            user("kept message"),
            user("newer question"),
            { role: "assistant", content: [{ type: "text", text: "newer answer" }] },
            user("latest"),
        ]);
        await agent.close();
    });
});

describe("AgentBase instructions and tools hooks", () => {
    it("uses the instructions and tools the hooks return for the session", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "hooked" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        let executions = 0;
        const hookedTool = defineAgentTool({
            name: "hooked",
            returnType: Type.Object({}),
            execute: () => {
                executions += 1;
                return Promise.resolve({});
            },
            toLLM: () => [{ type: "text", text: "ok" }],
        });
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { instructions: "state instructions" },
            hooks: {
                instructions: (hookCtx) => {
                    // The hook context carries the agent's configuration namespaces.
                    expect(agentBaseProvider(hookCtx)).toBe("scripted");
                    return "hooked instructions";
                },
                tools: () => [hookedTool],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The hooks answered for the session, the request, and the tool execution alike, even
        // though the state carries different instructions and no tools.
        expect(provider.sessions[0]?.options.instructions).toBe("hooked instructions");
        expect(provider.sessions[0]?.options.tools).toEqual([hookedTool]);
        expect(provider.sessions[0]?.requests[0]?.context.instructions).toBe(
            "hooked instructions",
        );
        expect(executions).toBe(1);
        await agent.close();
    });

    it("falls back to the state when a hook throws", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { instructions: "state instructions" },
            hooks: {
                instructions: () => {
                    throw new Error("hook broke");
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.instructions).toBe(
            "state instructions",
        );
        await agent.close();
    });

    it("provides the configuration namespaces to tool executions too", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "call-1", name: "check_ctx" },
                { type: "toolcall_end", callId: "call-1", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        let seenModel: string | undefined;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "tool-visible-model",
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "check_ctx",
                        returnType: Type.Object({}),
                        execute: (toolCtx) => {
                            seenModel = agentBaseModel(toolCtx);
                            return Promise.resolve({});
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(seenModel).toBe("tool-visible-model");
        await agent.close();
    });
});

describe("AgentBase inference errors", () => {
    it("continues draining queued messages after a provider-reported error", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "partial answer" },
                { type: "text_end" },
                { type: "done", state: "error", kind: "unknown", message: "model overloaded" },
            ],
            textTurn("second answer"),
        ]);
        const persistence = new InMemoryPersistence();
        const events: SessionEvent[] = [];
        let agent: AgentBase;
        let queued = false;
        agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    events.push(event);
                    if (event.type === "text_delta" && !queued) {
                        queued = true;
                        void agent.send(ctx, user("still waiting"));
                    }
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The failed response never answered the queued message, so it drained into a fresh
        // inference instead of stranding until the next trigger.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("still waiting"));
        expect(
            events.filter((event) => event.type === "done").map((event) => event.state),
        ).toEqual(["error", "normal"]);
        // The later successful response recovered the error, so the failed response leaves
        // no system message behind.
        expect(persistence.records.some((record) => record.type === "system")).toBe(false);
        await agent.close();
    });

    it("surfaces a failed turn as a system message the next inference sees", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [{ type: "done", state: "error", kind: "unknown", message: "model overloaded" }],
            textTurn("second answer"),
        ]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const failure = {
            role: "system" as const,
            content: [{ type: "text" as const, text: "The last turn failed: model overloaded" }],
        };
        expect(persistence.records.at(-1)).toEqual({ type: "system", message: failure });

        // The next turn sees the surfaced failure in its context.
        await agent.send(ctx, user("again"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("go"),
            failure,
            user("again"),
        ]);
        await agent.close();
    });

    it("goes idle after an error when nothing is queued", async () => {
        const provider = new ScriptedProvider([
            [{ type: "done", state: "error", kind: "unknown", message: "model overloaded" }],
            textTurn("never"),
        ]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });
});

describe("AgentBase lifecycle hooks", () => {
    it("fires the lifecycle hooks in order around a turn", async () => {
        const order: string[] = [];
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeAgentLoop: () => void order.push("beforeAgentLoop"),
                beforeTurn: () => void order.push("beforeTurn"),
                beforeInference: () => void order.push("beforeInference"),
                afterInference: () => void order.push("afterInference"),
                afterTurn: () => {
                    order.push("afterTurn");
                    return undefined;
                },
                afterAgentLoop: () => {
                    order.push("afterAgentLoop");
                    return undefined;
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(order).toEqual([
            "beforeAgentLoop",
            "beforeTurn",
            "beforeInference",
            "afterInference",
            "afterTurn",
            "afterAgentLoop",
        ]);
        await agent.close();
    });

    it("runs another turn in the same loop when afterTurn queues a message", async () => {
        const order: string[] = [];
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let injected = false;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeAgentLoop: () => void order.push("beforeAgentLoop"),
                beforeTurn: () => void order.push("beforeTurn"),
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "send", message: user("follow up") }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("follow up"));
        // Both turns ran inside one loop span.
        expect(order).toEqual(["beforeAgentLoop", "beforeTurn", "beforeTurn"]);
        await agent.close();
    });

    it("applies every returned action together", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let injected = false;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sendMode: "all",
            hooks: {
                afterTurn: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [
                        { type: "send", message: user("first extra") },
                        { type: "send", message: user("second extra") },
                    ];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // Both actions were queued before the loop continued, so they drain into one inference.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("first extra"),
            user("second extra"),
        ]);
        await agent.close();
    });

    it("reopens the loop when afterAgentLoop steers a message", async () => {
        const order: string[] = [];
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let injected = false;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeAgentLoop: () => void order.push("beforeAgentLoop"),
                afterAgentLoop: () => {
                    order.push("afterAgentLoop");
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "steer", message: user("one more thing") }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("one more thing"));
        // The action reopened the loop, so the loop hooks bracketed two spans.
        expect(order).toEqual([
            "beforeAgentLoop",
            "afterAgentLoop",
            "beforeAgentLoop",
            "afterAgentLoop",
        ]);
        await agent.close();
    });

    it("triggers a compaction when afterTurn asks for one", async () => {
        const compactionMessage: SessionMessage = {
            role: "compaction",
            content: "summary of everything so far",
            encryptedContent: null,
        };
        const provider = new ScriptedProvider([textTurn("answer")]);
        let requested = false;
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                afterTurn: () => {
                    if (requested) return undefined;
                    requested = true;
                    const session = provider.sessions[0];
                    if (session !== undefined) {
                        session.compactionResults = [
                            {
                                status: "completed",
                                preservedMessages: [],
                                usage: {
                                    input: 10,
                                    output: 5,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    totalTokens: 15,
                                },
                                context: { instructions: "", messages: [compactionMessage] },
                            },
                        ];
                    }
                    return [{ type: "compact" }];
                },
            },
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions).toHaveLength(1);
        // A fresh turn after the compaction runs on the replaced context.
        expect(provider.sessions[0]?.compactions[0]?.context.messages).toEqual([
            user("go"),
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ]);
        await agent.close();
    });
});

describe("AgentBase load retry", () => {
    it("retries a failed history load on the next turn", async () => {
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("earlier") },
            { type: "block", block: { type: "text", text: "earlier reply" } },
        ]);
        const originalLoad = persistence.load.bind(persistence);
        let failures = 1;
        persistence.load = () => {
            if (failures > 0) {
                failures -= 1;
                return Promise.reject(new Error("storage offline"));
            }
            return originalLoad();
        };
        const events: SessionEvent[] = [];
        const provider = new ScriptedProvider([textTurn("recovered reply")]);
        const agent = new AgentBase(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("first try"));
        await agent.waitForIdle();
        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "storage offline",
            },
        ]);

        // The next trigger retries the load; the earlier message is still queued and drains.
        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("earlier"),
            { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
            user("first try"),
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        await agent.close();
    });
});
