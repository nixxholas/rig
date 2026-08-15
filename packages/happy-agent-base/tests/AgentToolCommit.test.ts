import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    AgentKV,
    agentKV,
    cuid2Schema,
    defineAgentTool,
    type AgentToolCall,
} from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agent-tool-commit-test");

function toolCallTurn(providerCallId: string, name: string): SessionEvent[] {
    return [
        { type: "toolcall_start", callId: providerCallId, name },
        { type: "toolcall_end", callId: providerCallId, arguments: "{}" },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

const resultSchema = Type.Object({ value: Type.String() });
type Result = { readonly value: string };

describe("transactional tool commits", () => {
    it("provides separate internal/provider IDs and lets the first committed result win", async () => {
        const providerCallId = "provider.call.with.dots";
        const persistence = new InMemoryPersistence();
        let received: AgentToolCall<typeof resultSchema> | undefined;
        let secondCommit: Result | undefined;
        let storedDuringExecution: unknown;
        let operationFactoryCalls = 0;
        const tool = defineAgentTool({
            name: "transactional",
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                received = call;
                storedDuringExecution = [...persistence.values.entries()].find(([key]) =>
                    key.startsWith("tool."),
                )?.[1];
                return await call.kv.transaction(toolCtx, async (kv, txCtx) => {
                    await kv.write(txCtx, "temporary", "value");
                    const operationId = await kv.getOrCreate(txCtx, "operation", () => {
                        operationFactoryCalls += 1;
                        return "operation-1";
                    });
                    expect(await kv.getOrCreate(txCtx, "operation", () => "operation-2")).toBe(
                        operationId,
                    );
                    const first = await call.commit(txCtx, { value: "committed first" });
                    secondCommit = await call.commit(txCtx, {
                        invalid: "ignored after winner",
                    } as never);
                    expect(first).toEqual({ value: "committed first" });
                    return { value: "ignored return" };
                });
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const provider = new ScriptedProvider([
            toolCallTurn(providerCallId, tool.name),
            textTurn("done"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "transactional-tool",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"), { await: true });
        await agent.waitForIdle();

        expect(received?.providerCallId).toBe(providerCallId);
        expect(Value.Check(cuid2Schema, received?.id)).toBe(true);
        expect(received?.id).not.toBe(providerCallId);
        expect(secondCommit).toEqual({ value: "committed first" });
        expect(operationFactoryCalls).toBe(1);
        expect(storedDuringExecution).toMatchObject({
            id: received?.id,
            providerCallId,
        });
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: providerCallId,
            content: [{ type: "text", text: "committed first" }],
        });
        expect(
            [...persistence.values.keys()].filter((key) =>
                key.startsWith(`kv.transactional-tool.call.${received?.id}.`),
            ),
        ).toEqual([]);
        await agent.close();
    });

    it("erases the bound KV atomically for ordinary returned results too", async () => {
        const persistence = new InMemoryPersistence();
        let id = "";
        let lateCommit!: () => Promise<Result>;
        const tool = defineAgentTool({
            name: "ordinary",
            returnType: resultSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                id = call.id;
                lateCommit = async () =>
                    await call.commit(toolCtx, { value: "too late to commit" });
                await call.kv.write(toolCtx, "temporary", true);
                return { value: "ordinary result" };
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const agent = await AgentBase.create(ctx, {
            id: "ordinary-tool",
            providers: providersOf(
                new ScriptedProvider([
                    toolCallTurn("provider-ordinary", tool.name),
                    textTurn("ok"),
                ]),
            ),
            provider: "scripted",
            persistence,
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"), { await: true });
        await agent.waitForIdle();

        expect(id).not.toBe("");
        await expect(lateCommit()).rejects.toThrow("can no longer commit");
        expect(
            [...persistence.values.keys()].filter((key) =>
                key.startsWith(`kv.ordinary-tool.call.${id}.`),
            ),
        ).toEqual([]);
        await agent.close();
    });

    it("keeps call KV available when result rendering rejects a commit before persistence", async () => {
        let firstFailure: unknown;
        const tool = defineAgentTool({
            name: "render_retry",
            returnType: resultSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                try {
                    await call.commit(toolCtx, { value: "bad rendering" });
                } catch (error: unknown) {
                    firstFailure = error;
                }
                await call.kv.write(toolCtx, "retry-still-live", true);
                return await call.commit(toolCtx, { value: "good rendering" });
            },
            toLLM: (result) => {
                if (result.value === "bad rendering") throw new Error("render failed");
                return [{ type: "text", text: result.value }];
            },
        });
        const provider = new ScriptedProvider([
            toolCallTurn("provider-render-retry", tool.name),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "render-retry-tool",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"), { await: true });
        await agent.waitForIdle();

        expect(firstFailure).toMatchObject({ message: "render failed" });
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "provider-render-retry",
            content: [{ type: "text", text: "good rendering" }],
        });
        await agent.close();
    });

    it("lets an in-flight bounded write finish before commit cleanup erases its scope", async () => {
        let releaseWrite!: () => void;
        let writeStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            writeStarted = resolve;
        });
        const released = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        class PausingPersistence extends InMemoryPersistence {
            override async writeValue(
                writeCtx: Parameters<InMemoryPersistence["writeValue"]>[0],
                key: string,
                value: unknown,
            ): Promise<void> {
                if (key === "call.value") {
                    writeStarted();
                    await released;
                }
                await super.writeValue(writeCtx, key, value);
            }
        }
        const persistence = new PausingPersistence();
        const callKV = new AgentKV(persistence, "call.").serialized();
        const lifetime = new AbortController();
        const bounded = callKV.until(lifetime.signal);

        const write = bounded.write(ctx, "value", true);
        await started;
        const clear = callKV.clear(ctx);
        lifetime.abort();
        releaseWrite();
        await write;
        await clear;

        expect(await callKV.read(ctx, "value")).toBeUndefined();
    });

    it("persists one internal identity for undispatched error settlement and clears its KV", async () => {
        const persistence = new InMemoryPersistence();
        const prefixes: string[] = [];
        let failSettlement = true;
        const hooks = {
            afterToolCallTransact: async (hookCtx: Context) => {
                const kv = agentKV(hookCtx);
                if (kv === undefined) throw new Error("missing call KV");
                prefixes.push(kv.prefix);
                await kv.write(hookCtx, "temporary", true);
                if (failSettlement) {
                    failSettlement = false;
                    throw new Error("retry settlement");
                }
            },
        };
        const first = await AgentBase.create(ctx, {
            id: "undispatched-tool-settlement",
            providers: providersOf(
                new ScriptedProvider([
                    [
                        {
                            type: "toolcall_start",
                            callId: "provider-undispatched",
                            name: "missing",
                        },
                        {
                            type: "toolcall_end",
                            callId: "provider-undispatched",
                            arguments: "{}",
                        },
                        {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: "provider failed",
                        },
                    ],
                ]),
            ),
            provider: "scripted",
            persistence,
            hooks,
        });
        await first.send(ctx, user("begin"), { await: true });
        while (prefixes.length === 0) await Promise.resolve();
        await first.close();

        const second = await AgentBase.load(ctx, {
            id: "undispatched-tool-settlement",
            providers: providersOf(new ScriptedProvider([textTurn("continued")])),
            provider: "scripted",
            persistence,
            hooks,
        });
        second.start();
        await second.waitForIdle();

        expect(prefixes).toHaveLength(2);
        expect(prefixes[1]).toBe(prefixes[0]);
        expect(
            [...persistence.values.keys()].filter((key) => key.startsWith(prefixes[0]!)),
        ).toEqual([]);
        await second.close();
    });

    it("settles from a committed result without waiting for execute to return", async () => {
        let postCommitWrite: unknown;
        let committed!: () => void;
        const committedResult = new Promise<void>((resolve) => {
            committed = resolve;
        });
        const tool = defineAgentTool({
            name: "commit_then_wait",
            returnType: resultSchema,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _args, call) => {
                await call.commit(toolCtx, { value: "already durable" });
                committed();
                try {
                    await call.kv.write(ctx, "recreated", true);
                } catch (error: unknown) {
                    postCommitWrite = error;
                }
                return await new Promise<Result>(() => undefined);
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });
        const provider = new ScriptedProvider([
            toolCallTurn("provider-early", tool.name),
            textTurn("continued"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "early-tool-commit",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { tools: [tool] },
        });

        await agent.send(ctx, user("run it"), { await: true });
        await committedResult;
        await agent.waitForIdle();

        expect(postCommitWrite).toMatchObject({
            message: "The store cannot be used: the work its context belongs to has ended.",
        });
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "provider-early",
            content: [{ type: "text", text: "already durable" }],
        });
        await agent.close();
    });

    it.each(["abort", "close"] as const)(
        "keeps the committed winner when %s races the still-running execution",
        async (ending) => {
            const persistence = new InMemoryPersistence();
            let committed!: () => void;
            const committedResult = new Promise<void>((resolve) => {
                committed = resolve;
            });
            const tool = defineAgentTool({
                name: `commit_before_${ending}`,
                returnType: resultSchema,
                shouldReviewInAutoMode: () => false,
                execute: async (toolCtx, _args, call) => {
                    await call.commit(toolCtx, { value: "winner" });
                    committed();
                    return await new Promise<Result>(() => undefined);
                },
                toLLM: (result) => [{ type: "text", text: result.value }],
            });
            const agent = await AgentBase.create(ctx, {
                id: `commit-${ending}-race`,
                providers: providersOf(
                    new ScriptedProvider([
                        toolCallTurn(`provider-${ending}`, tool.name),
                        textTurn("continued"),
                    ]),
                ),
                provider: "scripted",
                persistence,
                initialState: { tools: [tool] },
            });

            await agent.send(ctx, user("run it"), { await: false });
            await committedResult;
            if (ending === "abort") {
                await agent.abort(ctx);
                await agent.waitForIdle();
            } else {
                await agent.close();
            }

            expect(persistence.records.findLast((record) => record.type === "tool")).toMatchObject({
                type: "tool",
                message: {
                    callId: `provider-${ending}`,
                    content: [{ type: "text", text: "winner" }],
                },
            });
            if (ending === "abort") await agent.close();
        },
    );
});
