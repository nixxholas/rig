import type {
    SessionAssistantBlock,
    SessionEvent,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    agentEffort,
    agentModel,
    agentProvider,
    agentServiceTier,
    defineAgentTool,
    type AnyAgentTool,
} from "../../sources/index.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { providersOf, queued, system, textTurn, user } from "../gym/fixtures.js";
import { ScriptedProvider } from "../gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-base-blackbox-test");

type ToolCallSpec = {
    readonly callId: string;
    readonly name: string;
    readonly arguments?: string;
    readonly namespace?: string;
    readonly server?: true;
    readonly incomplete?: boolean;
};

function toolCallTurn(calls: readonly ToolCallSpec[]): SessionEvent[] {
    return [
        ...calls.flatMap((call): SessionEvent[] => [
            {
                type: "toolcall_start",
                callId: call.callId,
                name: call.name,
                ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
                ...(call.server === undefined ? {} : { server: call.server }),
            },
            {
                type: "toolcall_end",
                callId: call.callId,
                arguments: call.arguments ?? "{}",
                ...(call.incomplete === undefined ? {} : { incomplete: call.incomplete }),
            },
        ]),
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

function toolResult(callId: string, text: string, isError?: boolean): SessionToolResultMessage {
    return {
        role: "tool",
        callId,
        content: [{ type: "text", text }],
        ...(isError === true ? { isError: true } : {}),
    };
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

describe("AgentBase black-box stream and request behavior", () => {
    it("forwards every stream event even when the observer throws", async () => {
        const scriptedEvents: SessionEvent[] = [
            { type: "block_start" },
            { type: "reasoning_start" },
            { type: "reasoning_delta", delta: "thinking" },
            { type: "reasoning_end", reasoning: "opaque-signature" },
            { type: "block_stop" },
            { type: "text_start" },
            { type: "text_delta", delta: "hello" },
            { type: "text_end" },
            {
                type: "toolcall_start",
                callId: "server-call",
                name: "remote_search",
                server: true,
                vendor: { trace: "server-owned" },
            },
            { type: "toolcall_delta", callId: "server-call", delta: "{}" },
            {
                type: "toolcall_end",
                callId: "server-call",
                arguments: "{}",
            },
            { type: "toolcall_result_start", callId: "server-call", vendor: { id: "r1" } },
            { type: "toolcall_result_delta", callId: "server-call", delta: "remote result" },
            {
                type: "toolcall_result_end",
                callId: "server-call",
                content: [{ type: "text", text: "remote result" }],
            },
            { type: "retrying", attempt: 1, reason: "provider retry" },
            {
                type: "token_usage",
                usage: {
                    input: 10,
                    output: 4,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 14,
                },
            },
            {
                type: "done",
                state: "tool_call",
                tokens: { input: 10, output: 4 },
            },
        ];
        const observed: SessionEvent[] = [];
        const provider = new ScriptedProvider([[...scriptedEvents]]);
        const agent = await AgentBase.create(ctx, {
            id: "stream-observer",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_hookCtx, event) => {
                    observed.push(event);
                    throw new Error("observer failed");
                },
            },
        });

        await agent.send(ctx, user("observe this"), { await: true });
        await agent.waitForIdle();

        expect(observed).toEqual(scriptedEvents);
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("passes instructions and tools at session creation and model settings on every request", async () => {
        const tool = defineAgentTool({
            name: "namespaced_tool",
            namespace: "files",
            namespaceDescription: "File operations",
            description: "Reads a file.",
            parameters: Type.Object({ path: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({ value: "contents" }),
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "request-forwarding",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { instructions: "Use concise answers.", tools: [tool] },
            model: "model-under-test",
            effort: "xhigh",
            serviceTier: "priority",
        });

        await agent.send(ctx, user("question"), { await: true });
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.id).toBe("request-forwarding");
        expect(session?.options.instructions).toBe("Use concise answers.");
        expect(session?.options.tools).toEqual([tool]);
        expect(session?.requests[0]).toMatchObject({
            model: "model-under-test",
            effort: "xhigh",
            serviceTier: "priority",
            context: {
                instructions: "Use concise answers.",
                messages: [user("question")],
            },
        });
        // The run context is derived from the constructor context and carries the agent's
        // provider, model, effort, and service tier in its namespaces.
        const requestContext = session?.requestContexts[0];
        expect(requestContext).toBeDefined();
        if (requestContext !== undefined) {
            expect(agentModel(requestContext)).toBe("model-under-test");
            expect(agentEffort(requestContext)).toBe("xhigh");
            expect(agentProvider(requestContext)).toBe("scripted");
            expect(agentServiceTier(requestContext)).toBe("priority");
        }
        await agent.close();
    });

    it.each([
        {
            state: "length" as const,
            done: {
                type: "done" as const,
                state: "length" as const,
                tokens: { input: 3, output: 2 },
            },
        },
        {
            state: "cancelled" as const,
            done: { type: "done" as const, state: "cancelled" as const },
        },
    ])("forwards a $state done state and does not invent assistant content", async ({ done }) => {
        const events: SessionEvent[] = [done];
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([[done]]);
        const agent = await AgentBase.create(ctx, {
            id: `done-${done.state}`,
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        await agent.send(ctx, user("stop"), { await: true });
        await agent.waitForIdle();

        expect(events).toEqual([done, done]);
        expect(persistence.records).toEqual([{ type: "user", message: user("stop") }]);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        await agent.close();
    });

    it("does not add an assistant message when a normal turn has no blocks", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [{ type: "done", state: "normal", tokens: { input: 1, output: 0 } }],
            textTurn("second reply"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "empty-assistant",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("first"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("second"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([user("first")]);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("first"),
            user("second"),
        ]);
        expect(persistence.records).toEqual([
            { type: "user", message: user("first") },
            { type: "user", message: user("second") },
            { type: "block", block: { type: "text", text: "second reply" } },
        ]);
        await agent.close();
    });

    it("persists an explicitly finished empty text block", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 0 } },
            ],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "empty-text-block",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("empty reply"), { await: true });
        await agent.waitForIdle();

        expect(persistence.records).toEqual([
            { type: "user", message: user("empty reply") },
            { type: "block", block: { type: "text", text: "" } },
        ]);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([user("empty reply")]);
        await agent.close();
    });

    it("replays the complete context for multiple sequential turns", async () => {
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "sequential-turns",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("first"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("second"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("third"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests.map((request) => request.context.messages)).toEqual([
            [user("first")],
            [
                user("first"),
                { role: "assistant", content: [{ type: "text", text: "one" }] },
                user("second"),
            ],
            [
                user("first"),
                { role: "assistant", content: [{ type: "text", text: "one" }] },
                user("second"),
                { role: "assistant", content: [{ type: "text", text: "two" }] },
                user("third"),
            ],
        ]);
        await agent.close();
    });

    it("resolves send after the pending write while a blocked history load is still running", async () => {
        const persistence = new (class extends InMemoryPersistence {
            readonly gate = deferred<void>();

            override load(): ReturnType<InMemoryPersistence["load"]> {
                return this.gate.promise.then(() => super.load());
            }
        })();
        const provider = new ScriptedProvider([textTurn("eventually")]);
        let done = false;
        const agent = await AgentBase.create(ctx, {
            id: "send-timing",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_hookCtx, event) => {
                    if (event.type === "done") done = true;
                },
            },
        });

        const sent = agent.send(ctx, user("persist now"), { await: true });
        await sent;

        expect([...persistence.pending.values()]).toEqual([queued(user("persist now"))]);
        expect(done).toBe(false);
        let idleResolved = false;
        const idle = agent.waitForIdle().then(() => {
            idleResolved = true;
        });
        await Promise.resolve();
        expect(idleResolved).toBe(false);
        persistence.gate.resolve();
        await idle;
        expect(done).toBe(true);
        await agent.close();
    });
});

describe("AgentBase black-box persistence and restart behavior", () => {
    it("reconstructs consecutive assistant blocks and preserves message boundaries on replay", async () => {
        const firstCall: SessionAssistantBlock = {
            type: "tool_call",
            callId: "call-1",
            name: "lookup",
            arguments: '{"value":"one"}',
        };
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("question one") },
            { type: "block", block: { type: "reasoning", text: "thinking", reasoning: "sig" } },
            { type: "block", block: { type: "text", text: "partial" } },
            { type: "block", block: firstCall },
            {
                type: "tool",
                message: toolResult("call-1", "lookup result"),
            },
            { type: "block", block: { type: "text", text: "after tool" } },
            { type: "user", message: user("question two") },
        ]);
        const provider = new ScriptedProvider([textTurn("new answer"), textTurn("next answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "replay-boundaries",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("question three"), { await: true });
        await agent.waitForIdle();

        // The trailing seeded user message is unanswered, so recovery answers it first; the
        // follow-up waits for that response and joins the next request.
        const reconstructed = [
            user("question one"),
            {
                role: "assistant",
                content: [
                    { type: "reasoning", text: "thinking", reasoning: "sig" },
                    { type: "text", text: "partial" },
                    firstCall,
                ],
            },
            toolResult("call-1", "lookup result"),
            { role: "assistant", content: [{ type: "text", text: "after tool" }] },
            user("question two"),
        ];
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual(reconstructed);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            ...reconstructed,
            { role: "assistant", content: [{ type: "text", text: "new answer" }] },
            user("question three"),
        ]);
        await agent.close();
    });

    it("joins pending messages left by a previous process with a newly sent message in key order", async () => {
        const persistence = new InMemoryPersistence();
        persistence.values.set("send.00000000000001.000000", queued(user("old one")));
        persistence.values.set("send.00000000000002.000000", queued(user("old two")));
        const provider = new ScriptedProvider([textTurn("caught up")]);
        const agent = await AgentBase.create(ctx, {
            id: "pending-replay",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sendMode: "all",
        });

        await agent.send(ctx, user("new message"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("old one"),
            user("old two"),
            user("new message"),
        ]);
        expect(persistence.records.slice(0, 3)).toEqual([
            { type: "user", message: user("old one") },
            { type: "user", message: user("old two") },
            { type: "user", message: user("new message") },
        ]);
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("rolls every pending message back when a later pending delete fails", async () => {
        const persistence = new InMemoryPersistence();
        const first = queued(user("first pending"));
        const second = queued(user("second pending"));
        persistence.values.set("send.00000000000001.000000", first);
        persistence.values.set("send.00000000000002.000000", second);
        const originalDelete = persistence.deleteValue.bind(persistence);
        let deletes = 0;
        persistence.deleteValue = async (deleteContext, key) => {
            deletes += 1;
            if (deletes === 2) throw new Error("second delete failed");
            await originalDelete(deleteContext, key);
        };
        const events: SessionEvent[] = [];
        const provider = new ScriptedProvider([textTurn("never")]);
        const agent = await AgentBase.create(ctx, {
            id: "pending-atomicity",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sendMode: "all",
            hooks: { onEvent: (_hookCtx, event) => events.push(event) },
        });

        agent.start();
        await agent.waitForIdle();

        expect(events).toEqual([
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "second delete failed",
            },
        ]);
        expect(persistence.records).toEqual([
            {
                type: "system",
                message: {
                    role: "system",
                    content: [{ type: "text", text: "The last turn failed: second delete failed" }],
                },
            },
        ]);
        expect([...persistence.pending.entries()]).toEqual([
            ["send.00000000000001.000000", first],
            ["send.00000000000002.000000", second],
        ]);
        expect(provider.sessions).toHaveLength(0);
        await agent.close();
    });

    it("starts inference when durable history ends with a tool result", async () => {
        const call: SessionAssistantBlock = {
            type: "tool_call",
            callId: "unfinished-call",
            name: "lookup",
            arguments: "{}",
        };
        const result = toolResult("unfinished-call", "already done");
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("continue") },
            { type: "block", block: call },
            { type: "tool", message: result },
        ]);
        const provider = new ScriptedProvider([textTurn("continued")]);
        const agent = await AgentBase.create(ctx, {
            id: "tool-result-restart",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("continue"),
            { role: "assistant", content: [call] },
            result,
        ]);
        expect(persistence.records.at(-1)).toEqual({
            type: "block",
            block: { type: "text", text: "continued" },
        });
        await agent.close();
    });

    it("resumes an interrupted batch after an earlier result has already committed", async () => {
        const callA: SessionToolCallBlock = {
            type: "tool_call",
            callId: "call-a",
            name: "already-committed",
            arguments: "{}",
        };
        const callB: SessionToolCallBlock = {
            type: "tool_call",
            callId: "call-b",
            name: "durable-retry",
            arguments: "{}",
        };
        const callC: SessionToolCallBlock = {
            type: "tool_call",
            callId: "call-c",
            name: "fragile-retry",
            arguments: "{}",
        };
        const resultA = toolResult("call-a", "first result");
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("resume") },
            { type: "block", block: callA },
            { type: "block", block: callB },
            { type: "block", block: callC },
            { type: "tool", message: resultA },
        ]);
        persistence.values.set("tool.000001.call-b", callB);
        persistence.values.set("tool.000002.call-c", callC);
        const provider = new ScriptedProvider([textTurn("resumed")]);
        const executions: string[] = [];
        const makeTool = (name: string, durable: boolean) =>
            defineAgentTool({
                name,
                durable,
                returnType: Type.Object({ value: Type.String() }),
                shouldReviewInAutoMode: () => false,
                execute: async () => {
                    executions.push(name);
                    return { value: `${name} result` };
                },
                toLLM: (result) => [{ type: "text", text: result.value }],
            });
        const agent = await AgentBase.create(ctx, {
            id: "partial-tool-restart",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [makeTool("durable-retry", true), makeTool("fragile-retry", false)],
            },
        });

        agent.start();
        await agent.waitForIdle();

        expect(executions).toEqual(["durable-retry"]);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("resume"),
            { role: "assistant", content: [callA, callB, callC] },
            resultA,
            toolResult("call-b", "durable-retry result"),
            toolResult(
                "call-c",
                "The tool call was interrupted by a restart and was not retried.",
                true,
            ),
        ]);
        expect(
            persistence.records
                .filter((record) => record.type === "tool")
                .map((record) => record.message.callId),
        ).toEqual(["call-a", "call-b", "call-c"]);
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("dispatches a trailing tool call that was never committed as a batch", async () => {
        // The response's blocks are durable as they stream, so a crash between the last block
        // and the batch commit leaves a call with no pending entry to resume. It has certainly
        // not executed — the commit precedes every execution — so it is dispatched now, and
        // even a non-durable call is safe to run.
        const call: SessionToolCallBlock = {
            type: "tool_call",
            callId: "call-never-committed",
            name: "fragile",
            arguments: "{}",
        };
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("do it") },
            { type: "block", block: call },
        ]);
        const provider = new ScriptedProvider([textTurn("answered")]);
        const executions: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "undispatched-tool-restart",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "fragile",
                        durable: false,
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            executions.push("fragile");
                            return Promise.resolve({ value: "fragile result" });
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                ],
            },
        });

        agent.start();
        await agent.waitForIdle();

        expect(executions).toEqual(["fragile"]);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("do it"),
            { role: "assistant", content: [call] },
            toolResult("call-never-committed", "fragile result"),
        ]);
        // Nothing is left owed, and the conversation no longer holds an unanswered call.
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("settles a tool call the response emitted but never dispatched", async () => {
        // A stream that fails after emitting a call ends the turn without a batch. The call is
        // answered with an error rather than left in the conversation, where every later
        // message would be appended behind a call the model never got an answer for.
        const call: SessionToolCallBlock = {
            type: "tool_call",
            callId: "call-stranded",
            name: "never-run",
            arguments: "{}",
        };
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: call.callId, name: call.name },
                { type: "toolcall_end", callId: call.callId, arguments: "{}" },
                {
                    type: "done",
                    state: "error",
                    kind: "internal_error",
                    message: "upstream fell over",
                },
            ],
            textTurn("recovered"),
        ]);
        const executions: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "stranded-call",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "never-run",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () => {
                            executions.push("never-run");
                            return Promise.resolve({});
                        },
                        toLLM: () => [{ type: "text", text: "ran" }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        // The failed response never dispatched the call, so nothing ran.
        expect(executions).toEqual([]);
        const results = persistence.records.filter((record) => record.type === "tool");
        expect(results).toHaveLength(1);
        expect(results[0]?.message).toEqual(
            toolResult(
                "call-stranded",
                "The response ended before this tool call was dispatched.",
                true,
            ),
        );
        // The error result comes before the note about the failed turn, so the call is answered
        // where a provider expects its answer.
        const types = persistence.records.map((record) => record.type);
        expect(types.indexOf("tool")).toBeLessThan(types.indexOf("system"));
        await agent.close();
    });

    it("answers again after a restart when the last turn failed", async () => {
        // The note a failed turn leaves behind means the question it was given never got an
        // answer, so a restarted agent owes one — with the note itself as context.
        const persistence = new InMemoryPersistence([
            { type: "user", message: user("what happened?") },
            { type: "system", message: system("The last turn failed: the store fell over.") },
        ]);
        const provider = new ScriptedProvider([textTurn("here is the answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "failed-turn-restart",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(persistence.records.at(-1)).toEqual({
            type: "block",
            block: { type: "text", text: "here is the answer" },
        });
        await agent.close();
    });

    it("does not answer a compaction it restarts on", async () => {
        // A replacement written by a compaction can end on any message the summary happens to
        // use. It is not a question that was left unanswered, so a restart must not respond to
        // it — unlike a conversation cut off mid-turn.
        const persistence = new InMemoryPersistence([
            {
                type: "compaction",
                messages: [user("a summary of everything so far")],
            },
        ]);
        const provider = new ScriptedProvider([textTurn("unwanted")]);
        const agent = await AgentBase.create(ctx, {
            id: "restart-on-compaction",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.waitForIdle();

        expect(provider.sessions).toHaveLength(0);
        expect(persistence.records).toHaveLength(1);
        await agent.close();
    });

    it("queues messages in order across restarts that share a millisecond", async () => {
        // A restarted agent counts its queue keys from zero again. Without the durable order,
        // two messages queued in the same millisecond by two processes collide on one key and
        // the first one is simply overwritten.
        const persistence = new InMemoryPersistence();
        const options = {
            id: "restart-queue-order",
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            persistence,
        };
        const first = await AgentBase.create(ctx, options);
        await first.send(ctx, user("first"), { await: true });
        const second = await AgentBase.create(ctx, options);
        await second.send(ctx, user("second"), { await: true });

        const stored = [...persistence.pending.entries()]
            .filter(([key]) => key.startsWith("send."))
            .sort(([a], [b]) => (a < b ? -1 : 1));
        expect(stored.map(([, value]) => (value as { message: unknown }).message)).toEqual([
            user("first"),
            user("second"),
        ]);
        await first.close();
        await second.close();
    });

    it("leaves a tool pending when its result transaction fails so a restart can recover it", async () => {
        const call: SessionToolCallBlock = {
            type: "tool_call",
            callId: "crashed-result",
            name: "durable",
            arguments: "{}",
        };
        const persistence = new InMemoryPersistence();
        let transactionCount = 0;
        const realTransaction = persistence.transaction.bind(persistence);
        persistence.transaction = async (transactionContext, work) => {
            // Acceptance, consumption, and the tool dispatch commit first; the fourth is the one
            // that would record the tool's result.
            transactionCount += 1;
            if (transactionCount === 4) {
                throw new Error("result transaction crashed");
            }
            return realTransaction(transactionContext, work);
        };
        const firstProvider = new ScriptedProvider([toolCallTurn([call])]);
        const firstEvents: SessionEvent[] = [];
        let firstExecutions = 0;
        const makeDurableTool = () =>
            defineAgentTool({
                name: "durable",
                durable: true,
                returnType: Type.Object({ value: Type.String() }),
                shouldReviewInAutoMode: () => false,
                execute: async () => {
                    firstExecutions += 1;
                    return { value: "result" };
                },
                toLLM: (result) => [{ type: "text", text: result.value }],
            });
        const firstAgent = await AgentBase.create(ctx, {
            id: "crash-before-result",
            providers: providersOf(firstProvider),
            provider: "scripted",
            persistence,
            hooks: { onEvent: (_hookCtx, event) => firstEvents.push(event) },
            initialState: { tools: [makeDurableTool()] },
        });

        await firstAgent.send(ctx, user("recover"), { await: true });
        await firstAgent.waitForIdle();

        expect(firstExecutions).toBe(1);
        expect(firstEvents.at(-1)).toEqual({
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "result transaction crashed",
        });
        expect([...persistence.pending.entries()]).toEqual([["tool.000000.crashed-result", call]]);
        await firstAgent.close();

        const secondProvider = new ScriptedProvider([textTurn("recovered")]);
        const secondAgent = await AgentBase.create(ctx, {
            id: "recover-after-crash",
            providers: providersOf(secondProvider),
            provider: "scripted",
            persistence,
            initialState: { tools: [makeDurableTool()] },
        });

        secondAgent.start();
        await secondAgent.waitForIdle();

        expect(firstExecutions).toBe(2);
        // The crashed first turn surfaced its failure as a system message; the recovered tool
        // result lands after it, since the failure record was already durable at restart.
        expect(secondProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("recover"),
            { role: "assistant", content: [call] },
            {
                role: "system",
                content: [
                    { type: "text", text: "The last turn failed: result transaction crashed" },
                ],
            },
            toolResult("crashed-result", "result"),
        ]);
        expect(persistence.pending.size).toBe(0);
        await secondAgent.close();
    });

    it("keeps a transaction scoped to its own persistence instance", async () => {
        const first = new InMemoryPersistence();
        const second = new InMemoryPersistence();
        const firstRecord = { type: "user" as const, message: user("first") };
        const secondRecord = { type: "user" as const, message: user("second") };
        await expect(
            first.transaction(ctx, async (transactionContext) => {
                await first.append(transactionContext, firstRecord);
                await second.append(transactionContext, secondRecord);
                throw new Error("rollback first only");
            }),
        ).rejects.toThrow("rollback first only");

        expect(first.records).toEqual([]);
        expect(second.records).toEqual([secondRecord]);
    });
});

describe("AgentBase black-box tool validation and ordering", () => {
    const knownTool = () =>
        defineAgentTool({
            name: "known",
            parameters: Type.Object({ path: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({ value: "ok" }),
            toLLM: (result) => [{ type: "text", text: result.value }],
        });

    async function runInvalidToolCall(
        call: ToolCallSpec,
        expected: string,
        tools: readonly AnyAgentTool[] = [knownTool()],
    ): Promise<void> {
        const provider = new ScriptedProvider([toolCallTurn([call]), textTurn("follow-up")]);
        const agent = await AgentBase.create(ctx, {
            id: `invalid-${call.callId}`,
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [...tools] },
        });
        try {
            await agent.send(ctx, user("invoke"), { await: true });
            await agent.waitForIdle();

            expect(provider.sessions[0]?.requests).toHaveLength(2);
            expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
                role: "tool",
                callId: call.callId,
                content: [{ type: "text", text: expected }],
                isError: true,
            });
        } finally {
            await agent.close();
        }
    }

    it("returns the same public descriptor from defineAgentTool", () => {
        const tool = knownTool();

        expect(defineAgentTool(tool)).toBe(tool);
    });

    it("turns missing, incomplete, invalid-JSON, and schema-mismatched calls into error results", async () => {
        await runInvalidToolCall(
            { callId: "missing", name: "missing", arguments: "{}" },
            'Tool "missing" is not available.',
            [],
        );
        await runInvalidToolCall(
            { callId: "incomplete", name: "known", arguments: '{"path":"a"}', incomplete: true },
            "The tool call was incomplete and was not executed.",
        );
        await runInvalidToolCall(
            { callId: "json", name: "known", arguments: "{" },
            'The arguments for "known" were not valid JSON.',
        );
        await runInvalidToolCall(
            { callId: "schema", name: "known", arguments: '{"path":123}' },
            'The arguments for "known" did not match its schema.',
        );
    });

    it("parses whitespace-only arguments as an empty object before executing", async () => {
        let received: unknown;
        const provider = new ScriptedProvider([
            toolCallTurn([{ callId: "empty", name: "empty_args", arguments: " \n\t" }]),
            textTurn("done"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "empty-arguments",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "empty_args",
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: async (_toolCtx, args) => {
                            received = args;
                            return { value: "accepted" };
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("empty"), { await: true });
        await agent.waitForIdle();

        expect(received).toEqual({});
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(
            toolResult("empty", "accepted"),
        );
        await agent.close();
    });

    it("matches namespaced tools by both namespace and name", async () => {
        let executed = 0;
        const namespacedTool = defineAgentTool({
            name: "search",
            namespace: "web",
            namespaceDescription: "Web tools",
            returnType: Type.Object({ answer: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => {
                executed += 1;
                return { answer: "found" };
            },
            toLLM: (result) => [{ type: "text", text: `answer=${result.answer}` }],
        });
        const provider = new ScriptedProvider([
            toolCallTurn([{ callId: "namespaced", name: "search", namespace: "web" }]),
            textTurn("done"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "namespaced-tools",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [namespacedTool] },
        });

        await agent.send(ctx, user("search"), { await: true });
        await agent.waitForIdle();

        expect(executed).toBe(1);
        expect(provider.sessions[0]?.options.tools).toEqual([namespacedTool]);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(
            toolResult("namespaced", "answer=found"),
        );
        await agent.close();
    });

    it("does not match a namespaced call to a tool with the same name in another namespace", async () => {
        const namespacedTool = defineAgentTool({
            name: "search",
            namespace: "files",
            returnType: Type.Object({ answer: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({ answer: "wrong tool" }),
            toLLM: (result) => [{ type: "text", text: result.answer }],
        });

        await runInvalidToolCall(
            { callId: "wrong-namespace", name: "search", namespace: "web" },
            'Tool "search" is not available.',
            [namespacedTool],
        );
    });

    it("validates results before rendering them and preserves isError from a structured result", async () => {
        let rendered = 0;
        const invalidResultTool = defineAgentTool({
            name: "invalid_result",
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({ value: 123 }) as unknown as { value: string },
            toLLM: () => {
                rendered += 1;
                return [{ type: "text", text: "must not render" }];
            },
        });
        const errorResultTool = defineAgentTool({
            name: "structured_error",
            returnType: Type.Object({ value: Type.String(), failed: Type.Boolean() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({ value: "warning", failed: true }),
            toLLM: (result) => [{ type: "text", text: result.value }],
            isError: (result) => result.failed,
        });
        const provider = new ScriptedProvider([
            toolCallTurn([
                { callId: "invalid-result", name: "invalid_result" },
                { callId: "structured-error", name: "structured_error" },
            ]),
            textTurn("handled"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "result-validation",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [invalidResultTool, errorResultTool] },
        });

        await agent.send(ctx, user("run both"), { await: true });
        await agent.waitForIdle();

        expect(rendered).toBe(0);
        expect(provider.sessions[0]?.requests[1]?.context.messages.slice(-2)).toEqual([
            toolResult("invalid-result", 'Tool "invalid_result" returned an invalid result.', true),
            toolResult("structured-error", "warning", true),
        ]);
        await agent.close();
    });

    it("converts an execute throw into an error result without stopping the batch", async () => {
        const provider = new ScriptedProvider([
            toolCallTurn([
                { callId: "throws", name: "throws" },
                { callId: "works", name: "works" },
            ]),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "throwing-tool",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "throws",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            throw new Error("execute failed");
                        },
                        toLLM: () => [],
                    }),
                    defineAgentTool({
                        name: "works",
                        returnType: Type.Object({ value: Type.String() }),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => ({ value: "ok" }),
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("run"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests[1]?.context.messages.slice(-2)).toEqual([
            toolResult("throws", "execute failed", true),
            toolResult("works", "ok"),
        ]);
        await agent.close();
    });

    it("does not execute server-settled calls or create a client tool result", async () => {
        let executed = false;
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                {
                    type: "toolcall_start",
                    callId: "server",
                    name: "server_tool",
                    server: true,
                },
                { type: "toolcall_end", callId: "server", arguments: "{}" },
                {
                    type: "toolcall_result_start",
                    callId: "server",
                },
                {
                    type: "toolcall_result_end",
                    callId: "server",
                    content: [{ type: "text", text: "provider settled" }],
                },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "server-settled",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "server_tool",
                        server: { type: "native_server" },
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            executed = true;
                            return {};
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("server"), { await: true });
        await agent.waitForIdle();

        expect(executed).toBe(false);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(persistence.records).toEqual([
            { type: "user", message: user("server") },
            {
                type: "block",
                block: {
                    type: "tool_call",
                    callId: "server",
                    name: "server_tool",
                    arguments: "{}",
                    server: true,
                },
            },
        ]);
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });

    it("does not perform a second inference for a tool_call done state with no executable calls", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [{ type: "done", state: "tool_call", tokens: { input: 1, output: 0 } }],
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "empty-tool-batch",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("no calls"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(persistence.records).toEqual([{ type: "user", message: user("no calls") }]);
        await agent.close();
    });

    it("runs many tools in parallel, commits all pending keys first, and records results in call order", async () => {
        const calls = [0, 1, 2, 3, 4].map((index) => ({
            callId: `call-${index}`,
            name: `tool-${index}`,
        }));
        const latencies = [2, 12, 25, 1, 8];
        const finished: string[] = [];
        let keysAtFirstStart: string[] = [];
        let keysBeforeSecondResult: string[] = [];
        const persistence = new InMemoryPersistence();
        const tools = calls.map((call, index) =>
            defineAgentTool({
                name: call.name,
                returnType: Type.Object({ value: Type.String() }),
                shouldReviewInAutoMode: () => false,
                execute: async () => {
                    if (index === 0) {
                        keysAtFirstStart = [...persistence.values.keys()].filter((key) =>
                            key.startsWith("tool."),
                        );
                    }
                    await delay(latencies[index] ?? 0);
                    if (index === 1) {
                        keysBeforeSecondResult = [...persistence.values.keys()].filter((key) =>
                            key.startsWith("tool."),
                        );
                    }
                    finished.push(call.name);
                    return { value: call.name };
                },
                toLLM: (result) => [{ type: "text", text: result.value }],
            }),
        );
        const provider = new ScriptedProvider([toolCallTurn(calls), textTurn("all done")]);
        const agent = await AgentBase.create(ctx, {
            id: "parallel-order",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [...tools] },
        });

        await agent.send(ctx, user("parallel"), { await: true });
        await agent.waitForIdle();

        expect(keysAtFirstStart).toEqual(
            calls.map((_, index) => `tool.${String(index).padStart(6, "0")}.call-${index}`),
        );
        expect(keysBeforeSecondResult).toEqual([
            "tool.000001.call-1",
            "tool.000002.call-2",
            "tool.000003.call-3",
            "tool.000004.call-4",
        ]);
        expect(finished).not.toEqual(calls.map((call) => call.name));
        expect(
            persistence.records
                .filter((record) => record.type === "tool")
                .map((record) => record.message.callId),
        ).toEqual(calls.map((call) => call.callId));
        expect(provider.sessions[0]?.requests[1]?.context.messages.slice(-5)).toEqual(
            calls.map((call) => toolResult(call.callId, call.name)),
        );
        expect(persistence.pending.size).toBe(0);
        await agent.close();
    });
});

describe("AgentBase black-box lifecycle behavior", () => {
    it("resolves waitForIdle immediately when idle and rejects sends and starts after close", async () => {
        const provider = new ScriptedProvider([]);
        const agent = await AgentBase.create(ctx, {
            id: "close-contract",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await expect(agent.waitForIdle()).resolves.toBeUndefined();
        await agent.close();
        await expect(agent.send(ctx, user("after close"), { await: true })).rejects.toThrow(
            "The agent has been closed.",
        );
        expect(() => agent.start()).toThrow("The agent has been closed.");
        await agent.close();
        expect(provider.sessions).toHaveLength(0);
    });

    it("destroys the provider session once when closing an active session", async () => {
        const provider = new ScriptedProvider([textTurn("reply")]);
        const agent = await AgentBase.create(ctx, {
            id: "destroy-contract",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("close me"), { await: true });
        await agent.waitForIdle();
        await agent.close();
        await agent.close();

        expect(provider.sessions[0]?.destroyed).toBe(true);
        expect(provider.sessions[0]?.destroyCalls).toBe(1);
    });
});
