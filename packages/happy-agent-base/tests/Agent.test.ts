import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    Agent,
    agentKV,
    defineAgentTool,
    type AgentFeature,
    type AgentFeatureAgent,
} from "../sources/index.js";
import { providersOf, sharedKV, system, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-test");

function tool(name: string) {
    return defineAgentTool({
        name,
        returnType: Type.Object({}),
        shouldReviewInAutoMode: () => false,
        execute: () => Promise.resolve({}),
        toLLM: () => [{ type: "text", text: "ok" }],
    });
}

function feature(hooks: AgentFeature): AgentFeature {
    return { ...hooks };
}

function toolCallTurn(callId: string, name: string, argumentsJson: string): SessionEvent[] {
    return [
        { type: "toolcall_start", callId, name },
        { type: "toolcall_end", callId, arguments: argumentsJson },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

describe("Agent", () => {
    it("preserves each tool's Auto review and Full-access policy through feature assembly", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const reviewedTool = defineAgentTool({
            name: "publish",
            parameters: Type.Object({ target: Type.String() }),
            returnType: Type.Object({}),
            autoPermissionInstructions:
                "In Auto mode, describe why publishing this target is necessary.",
            describeAutoPermissionAction: ({ target }) => `publish ${JSON.stringify(target)}`,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: ({ target }) => target === "production",
            shouldRunInFullAccessInAutoMode: async ({ target }) => target === "production",
            execute: () => Promise.resolve({}),
            toLLM: () => [{ type: "text", text: "ok" }],
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [feature({ name: "publishing", tools: () => [reviewedTool] })],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        const assembled = provider.sessions[0]?.options.tools?.[0];
        expect(assembled).toBe(reviewedTool);
        expect(reviewedTool.autoPermissionInstructions).toContain("why publishing");
        expect(reviewedTool.requiresAutoOrFullAccess).toBe(true);
        expect(await reviewedTool.shouldReviewInAutoMode?.({ target: "production" }, ctx)).toBe(
            true,
        );
        expect(
            await reviewedTool.shouldRunInFullAccessInAutoMode?.({ target: "production" }, ctx),
        ).toBe(true);
        expect(reviewedTool.describeAutoPermissionAction?.({ target: "production" }, ctx)).toBe(
            'publish "production"',
        );
        await agent.close();
    });

    it("merges instructions and tools from every feature in order", async () => {
        const searchTool = tool("search");
        const editTool = tool("edit");
        const provider = new ScriptedProvider([textTurn("answer")]);
        const searchFeature = feature({
            name: "search",
            instructions: () => "You can search.",
            tools: () => [searchTool],
        });
        const editFeature = feature({
            name: "edit",
            instructions: () => "You can edit.",
            tools: () => [editTool],
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [searchFeature, editFeature],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.options.instructions).toBe("You can search.\n\nYou can edit.");
        expect(session?.options.tools).toEqual([searchTool, editTool]);
        expect(session?.requests[0]?.context.instructions).toBe("You can search.\n\nYou can edit.");
        await agent.close();
    });

    it("composes tool middleware in feature order without executing downstream work twice", async () => {
        const provider = new ScriptedProvider([
            toolCallTurn("call-1", "mutate", "{}"),
            textTurn("done"),
        ]);
        const order: string[] = [];
        let executions = 0;
        const mutate = defineAgentTool({
            name: "mutate",
            parameters: Type.Object({}, { additionalProperties: false }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async () => {
                executions += 1;
                order.push("tool");
                return { value: "ok" };
            },
            toLLM: ({ value }) => [{ type: "text", text: value }],
        });
        const wrapper = (name: string): AgentFeature =>
            feature({
                name,
                aroundToolExecution: async (_hookCtx, _scope, execution) => {
                    order.push(`${name}:before`);
                    const [first, second] = await Promise.all([
                        execution.execute(),
                        execution.execute(),
                    ]);
                    expect(second).toBe(first);
                    order.push(`${name}:after`);
                    return first;
                },
            });
        const agent = await Agent.create(ctx, {
            id: "middleware-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [
                wrapper("outer"),
                wrapper("inner"),
                feature({ name: "tools", tools: () => [mutate] }),
            ],
        });

        await agent.send(ctx, user("mutate"), { await: true });
        await agent.waitForIdle();

        expect(executions).toBe(1);
        expect(order).toEqual([
            "outer:before",
            "inner:before",
            "tool",
            "inner:after",
            "outer:after",
        ]);
        await agent.close();
    });

    it("fans events out to every feature in order", async () => {
        const seen: string[] = [];
        const observe = (name: string): AgentFeature =>
            feature({
                name,
                onEvent: (_hookCtx, _scope, event) => {
                    if (event.type === "done") seen.push(name);
                },
            });
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [observe("first"), observe("second")],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(seen).toEqual(["first", "second"]);
        await agent.close();
    });

    it("concatenates lifecycle actions from every feature", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let done = false;
        const followUp = (text: string): AgentFeature =>
            feature({
                name: `follow-up-${text.replaceAll(" ", "-")}`,
                afterTurn: () => {
                    if (done) return undefined;
                    return [{ type: "send", message: user(text) }];
                },
            });
        const stop = feature({
            name: "stop",
            afterTurn: () => {
                done = true;
                return undefined;
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            sendMode: "all",
            features: [followUp("from first"), followUp("from second"), stop],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        // Both features' actions were applied together and drained into one follow-up turn.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("from first"),
            user("from second"),
        ]);
        await agent.close();
    });

    it("lets the first answering feature win the reset injection while all observe the change", async () => {
        const provider = new ScriptedProvider([textTurn("claude"), textTurn("gpt")]);
        const observed: boolean[] = [];
        const silent = feature({
            name: "silent",
            modelChanged: (_hookCtx, _scope, change) => {
                observed.push(change.wasReset);
                return undefined;
            },
        });
        const summarizer = feature({
            name: "summarizer",
            modelChanged: () => system("summary"),
        });
        const late = feature({
            name: "late",
            modelChanged: (_hookCtx, _scope, change) => {
                observed.push(change.wasReset);
                return system("should lose");
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            model: "anthropic/claude",
            features: [silent, summarizer, late],
        });

        await agent.send(ctx, user("hello"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { await: true, model: "openai/gpt" });
        await agent.waitForIdle();

        expect(observed).toEqual([true, true]);
        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            system("summary"),
            user("switch"),
        ]);
        await agent.close();
    });

    it("isolates a throwing observer so later features still see everything", async () => {
        const seen: string[] = [];
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let done = false;
        const broken = feature({
            name: "broken",
            onEvent: () => {
                throw new Error("observer broke");
            },
            beforeTurn: () => {
                throw new Error("lifecycle broke");
            },
            afterTurn: () => {
                throw new Error("actions broke");
            },
        });
        const working = feature({
            name: "working",
            onEvent: (_hookCtx, _scope, event) => {
                if (event.type === "done") seen.push("event");
            },
            beforeTurn: () => void seen.push("turn"),
            afterTurn: () => {
                if (done) return undefined;
                done = true;
                return [{ type: "send", message: user("follow up") }];
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [broken, working],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        // The broken feature silenced nothing: the working feature observed both turns and
        // its follow-up action survived the broken feature's afterTurn failure.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("follow up"));
        expect(seen).toEqual(["turn", "event", "turn", "event"]);
        await agent.close();
    });

    it("supports asynchronous feature hooks", async () => {
        const asyncTool = tool("async_tool");
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [
                feature({
                    name: "async",
                    instructions: () => Promise.resolve("async instructions"),
                    tools: () => Promise.resolve([asyncTool]),
                }),
            ],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.options.instructions).toBe("async instructions");
        expect(provider.sessions[0]?.options.tools).toEqual([asyncTool]);
        await agent.close();
    });

    it("rejects an incompatible switch when a model-change feature fails", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const persistence = new InMemoryPersistence();
        const broken = feature({
            name: "broken",
            modelChanged: () => {
                throw new Error("handoff broke");
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            model: "anthropic/claude",
            features: [broken],
        });

        await agent.send(ctx, user("hello"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { await: true, model: "openai/gpt" });
        await agent.waitForIdle();

        // The failed handoff rejected the switch: the history survived and the previous
        // model stayed effective.
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.destroyed).toBe(false);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("hello"),
            { role: "assistant", content: [{ type: "text", text: "first" }] },
            user("switch"),
        ]);
        expect(provider.sessions[0]?.requests[1]).toMatchObject({
            model: "anthropic/claude",
        });
        await agent.close();
    });

    it("fails the turn when two features register the same tool", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const events: string[] = [];
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [
                feature({ name: "first-bash", tools: () => [tool("bash")] }),
                feature({ name: "second-bash", tools: () => [tool("bash")] }),
                feature({
                    name: "observer",
                    onEvent: (_hookCtx, _scope, event) => {
                        if (event.type === "done" && event.state === "error") {
                            events.push(event.message);
                        }
                    },
                }),
            ],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions).toHaveLength(0);
        expect(events).toEqual(['Two tools are registered as "bash".']);
        await agent.close();
    });

    it("keeps the base fallbacks when no feature implements a hook", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const events: SessionEvent[] = [];
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            initialState: { instructions: "state instructions" },
            features: [
                feature({
                    name: "observer",
                    onEvent: (_hookCtx, _scope, event) => events.push(event),
                }),
            ],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        // No feature implements instructions, so the mutable state answers as usual.
        expect(provider.sessions[0]?.requests[0]?.context.instructions).toBe("state instructions");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        await agent.close();
    });

    it("scopes each feature's store to the feature's name", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const persistence = new InMemoryPersistence();
        const listed: unknown[] = [];
        const memory = feature({
            name: "memory",
            afterTurn: async (hookCtx) => {
                const kv = agentKV(hookCtx);
                if (kv === undefined) throw new Error("No store on the context.");
                await kv.write(hookCtx, "note", "remembered");
                listed.push(await kv.list(hookCtx));
                return undefined;
            },
        });
        const other = feature({
            name: "other",
            afterTurn: async (hookCtx) => {
                const kv = agentKV(hookCtx);
                if (kv === undefined) throw new Error("No store on the context.");
                // A feature sees only its own scope, never a sibling's entries.
                listed.push(await kv.list(hookCtx));
                return undefined;
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            features: [memory, other],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(persistence.values.get("kv.test-agent.feature.memory.note")).toBe("remembered");
        expect(listed).toEqual([[{ key: "note", value: "remembered" }], []]);
        await agent.close();
    });
    it("tells every hook which agent it is serving, and what it is running on", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const seen: AgentFeatureAgent[] = [];
        const agent = await Agent.create(ctx, {
            id: "identified-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            model: "gym/small",
            effort: "high",
            serviceTier: "priority",
            features: [
                feature({
                    name: "identity",
                    instructions: (_hookCtx, scope) => {
                        seen.push(scope.agent);
                        return "";
                    },
                }),
            ],
        });

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(seen[0]).toEqual({
            id: "identified-agent",
            provider: "scripted",
            providerKind: "gym",
            model: "gym/small",
            effort: "high",
            tier: "priority",
        });
        await agent.close();
    });

    it("lends each feature a run store that the settling transaction erases", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const persistence = new InMemoryPersistence();
        const withinRun: unknown[] = [];
        const whileSettling: unknown[] = [];
        const acrossRuns: unknown[] = [];
        let runs = 0;
        const notes = feature({
            name: "notes",
            beforeTurn: async (hookCtx, scope) => {
                runs += 1;
                // What an earlier run wrote about itself must not be here.
                acrossRuns.push(await scope.runKV.read(hookCtx, "note"));
                await scope.runKV.write(hookCtx, "note", `run ${runs}`);
                return undefined;
            },
            afterTurn: async (hookCtx, scope) => {
                withinRun.push(await scope.runKV.read(hookCtx, "note"));
                return undefined;
            },
            afterAgentSettledTransact: async (hookCtx, scope) => {
                // The run's notes are still readable here, and are gone once this commits.
                whileSettling.push(await scope.runKV.read(hookCtx, "note"));
            },
        });
        const agent = await Agent.create(ctx, {
            id: "run-store-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            features: [notes],
        });

        await agent.send(ctx, user("first"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("second"), { await: true });
        await agent.waitForIdle();

        expect(withinRun).toEqual(["run 1", "run 2"]);
        expect(whileSettling).toEqual(["run 1", "run 2"]);
        expect(acrossRuns).toEqual([undefined, undefined]);
        // Nothing the runs wrote about themselves outlives them.
        expect([...persistence.values.keys()].filter((key) => key.includes(".run."))).toEqual([]);
        await agent.close();
    });
});
