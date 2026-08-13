import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { asyncLock, createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    Agent,
    agentBaseKV,
    AgentBaseKV,
    AgentStorage,
    AgentSystemLocal,
    defineAgentTool,
    FeatureGoals,
    FeatureSubagents,
    type AgentFeature,
    type AgentFeatureConstructor,
    withAgentBaseContext,
    withAgentBaseKV,
    withAgentSystem,
} from "../../sources/index.js";
import { providersOf, textTurn, user } from "../gym/fixtures.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider } from "../gym/ScriptedProvider.js";

const ctx = createRootContext().named("feature-consistency-races-test");

describe("feature consistency races", () => {
    it("can retry a child spawn after its config commits but initial task delivery fails", async () => {
        const childId = "parent/audit";
        const childPersistence = new InMemoryPersistence();
        const persistenceByAgent = new Map<string, InMemoryPersistence>([
            [childId, childPersistence],
        ]);
        const provider = new ScriptedProvider([textTurn("done")]);
        const owner = makeAgents(provider, persistenceByAgent, [FeatureSubagents]);
        const parent = await owner.create(ctx, "parent", {});
        const feature = new FeatureSubagents("parent");
        await feature.load(withAgentSystem(ctx, owner));

        const originalWrite = childPersistence.writeValue.bind(childPersistence);
        let failInitialTask = true;
        childPersistence.writeValue = (writeCtx, key, value) => {
            if (failInitialTask && key.startsWith("send.")) {
                failInitialTask = false;
                return Promise.reject(new Error("transient child queue failure"));
            }
            return originalWrite(writeCtx, key, value);
        };
        const spawnCtx = withAgentBaseContext(ctx, {
            provider: "scripted",
            model: "openai/child",
            effort: "high",
            serviceTier: "priority",
        });

        try {
            await expect(
                feature.spawnAgentTool.execute(spawnCtx, {
                    task_name: "audit",
                    message: "Review the change.",
                }),
            ).rejects.toThrow("transient child queue failure");

            await expect(
                feature.spawnAgentTool.execute(spawnCtx, {
                    task_name: "audit",
                    message: "Review the change.",
                }),
            ).resolves.toEqual({ agent_id: childId });

            const child = await owner.resolve(ctx, childId);
            await child.waitForIdle();
            expect(provider.sessions[0]?.requests[0]?.context.messages[0]).toEqual(
                user("Review the change."),
            );
        } finally {
            childPersistence.writeValue = originalWrite;
            await owner
                .resolve(ctx, childId)
                .then(async (child) => child.close())
                .catch(() => undefined);
            await parent.close();
        }
    });

    it("does not lose a child completion when the first parent notification write fails", async () => {
        const parentPersistence = new InMemoryPersistence();
        const persistenceByAgent = new Map<string, InMemoryPersistence>([
            ["parent", parentPersistence],
        ]);
        const provider = new ScriptedProvider([textTurn("acknowledged")]);
        const owner = makeAgents(provider, persistenceByAgent, []);
        const parent = await owner.create(ctx, "parent", {});
        const feature = new FeatureSubagents("parent/child");
        await feature.load(withAgentSystem(ctx, owner));
        feature.onEvent(ctx, { type: "text_start" });
        feature.onEvent(ctx, { type: "text_delta", delta: "finished safely" });
        feature.onEvent(ctx, { type: "text_end" });
        feature.onEvent(ctx, {
            type: "done",
            state: "normal",
            tokens: { input: 1, output: 1 },
        });

        const originalWrite = parentPersistence.writeValue.bind(parentPersistence);
        let failNotification = true;
        parentPersistence.writeValue = (writeCtx, key, value) => {
            if (failNotification && key.startsWith("steering.")) {
                failNotification = false;
                return Promise.reject(new Error("transient parent queue failure"));
            }
            return originalWrite(writeCtx, key, value);
        };

        try {
            await feature.afterAgentSettled(ctx).catch(() => undefined);
            await feature.afterAgentSettled(ctx);
            await parent.waitForIdle();

            expect(
                parentPersistence.records.filter(
                    (record) =>
                        record.type === "user" &&
                        record.message.content.some(
                            (block) =>
                                block.type === "text" &&
                                block.text.includes("<agent_id>parent/child</agent_id>") &&
                                block.text.includes("finished safely"),
                        ),
                ),
            ).toHaveLength(1);
        } finally {
            parentPersistence.writeValue = originalWrite;
            await parent.close();
        }
    });

    it("keeps completion terminal when complete, pause, and resume race", async () => {
        const persistence = new InMemoryPersistence();
        const lock = asyncLock({ reentry: "block" });
        let runnerCalls = 0;
        const allTransitionsQueued = deferred<void>();
        const kv = new AgentBaseKV(
            persistence,
            "kv.goal-race.feature.goals.",
            async (operationCtx, work) => {
                runnerCalls += 1;
                if (runnerCalls === 5) allTransitionsQueued.resolve();
                return await lock.runInLock(operationCtx, work);
            },
        );
        const goalCtx = withAgentBaseKV(ctx, kv);
        const feature = new FeatureGoals({ objective: "Finish exactly once" });
        await feature.tools(goalCtx);

        const completeWriteStarted = deferred<void>();
        const releaseCompleteWrite = deferred<void>();
        const originalWrite = persistence.writeValue.bind(persistence);
        persistence.writeValue = async (writeCtx, key, value) => {
            if (key === "kv.goal-race.feature.goals.goal" && isGoalWithStatus(value, "complete")) {
                completeWriteStarted.resolve();
                await releaseCompleteWrite.promise;
            }
            await originalWrite(writeCtx, key, value);
        };

        try {
            const complete = feature.updateGoalTool.execute(goalCtx, {
                status: "complete",
            });
            await completeWriteStarted.promise;
            const pause = feature.pause(goalCtx);
            const resume = feature.resume(goalCtx);
            await allTransitionsQueued.promise;
            releaseCompleteWrite.resolve();

            const [completeResult, pauseResult, resumeResult] = await Promise.allSettled([
                complete,
                pause,
                resume,
            ]);

            expect.soft(completeResult).toMatchObject({
                status: "fulfilled",
                value: { goal: { status: "complete" } },
            });
            expect.soft(pauseResult).toMatchObject({
                status: "rejected",
                reason: expect.objectContaining({
                    message: expect.stringContaining("completed goal cannot be paused"),
                }),
            });
            expect.soft(resumeResult).toMatchObject({
                status: "rejected",
                reason: expect.objectContaining({
                    message: expect.stringContaining("completed goal cannot be resumed"),
                }),
            });
            expect.soft(feature.goal.status).toBe("complete");
            expect
                .soft(persistence.values.get("kv.goal-race.feature.goals.goal"))
                .toMatchObject({ status: "complete" });
        } finally {
            releaseCompleteWrite.resolve();
            persistence.writeValue = originalWrite;
        }
    });

    it("isolates a dotted KV scope segment from an equivalent dotted relative key", async () => {
        const persistence = new InMemoryPersistence();
        const root = directKV(persistence, "kv.");
        const dottedScope = root.scoped("alpha.beta");
        const dottedKey = root.scoped("alpha");

        await dottedScope.write(ctx, "state", "scope value");
        await dottedKey.write(ctx, "beta.state", "key value");

        expect.soft(await dottedScope.read(ctx, "state")).toBe("scope value");
        expect.soft(await dottedKey.read(ctx, "beta.state")).toBe("key value");
        expect.soft(persistence.values).toHaveLength(2);
    });

    it("isolates dotted feature names from dots in another feature's relative keys", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let dottedFeatureObserved: unknown;
        let dottedFeatureCalls = 0;
        const dottedFeature: AgentFeature = {
            name: "alpha.beta",
            instructions: async (featureCtx) => {
                const kv = requiredKV(featureCtx);
                dottedFeatureCalls += 1;
                if (dottedFeatureCalls === 1) {
                    await kv.write(featureCtx, "state", "dotted feature");
                } else {
                    dottedFeatureObserved = await kv.read(featureCtx, "state");
                }
                return "";
            },
        };
        const dottedKeyFeature: AgentFeature = {
            name: "alpha",
            instructions: async (featureCtx) => {
                await requiredKV(featureCtx).write(featureCtx, "beta.state", "dotted key");
                return "";
            },
        };
        const agent = new Agent(ctx, {
            id: "feature-scope-collision",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            features: [dottedFeature, dottedKeyFeature],
        });

        try {
            await agent.send(ctx, user("first"), { await: true });
            await agent.waitForIdle();
            await agent.send(ctx, user("second"), { await: true });
            await agent.waitForIdle();

            expect(dottedFeatureObserved).toBe("dotted feature");
        } finally {
            await agent.close();
        }
    });

    it("isolates dotted tool call IDs from dots in another call's relative keys", async () => {
        const persistence = new InMemoryPersistence();
        const bothWritesFinished = deferred<void>();
        let writes = 0;
        let dottedCallObserved: unknown;
        let dottedKeyCallObserved: unknown;
        const recordWrite = (): void => {
            writes += 1;
            if (writes === 2) bothWritesFinished.resolve();
        };
        const dottedCallTool = defineAgentTool({
            name: "dotted_call",
            parameters: Type.Object({}),
            returnType: Type.Object({}),
            execute: async (callCtx) => {
                const kv = requiredKV(callCtx);
                await kv.write(callCtx, "state", "dotted call");
                recordWrite();
                await bothWritesFinished.promise;
                dottedCallObserved = await kv.read(callCtx, "state");
                return {};
            },
            toLLM: () => [{ type: "text", text: "dotted call done" }],
        });
        const dottedKeyTool = defineAgentTool({
            name: "dotted_key",
            parameters: Type.Object({}),
            returnType: Type.Object({}),
            execute: async (callCtx) => {
                const kv = requiredKV(callCtx);
                await kv.write(callCtx, "one.state", "dotted key");
                recordWrite();
                await bothWritesFinished.promise;
                dottedKeyCallObserved = await kv.read(callCtx, "one.state");
                return {};
            },
            toLLM: () => [{ type: "text", text: "dotted key done" }],
        });
        const toolsFeature: AgentFeature = {
            name: "collision-tools",
            tools: () => [dottedCallTool, dottedKeyTool],
        };
        const provider = new ScriptedProvider([
            toolCallsTurn([
                { callId: "part.one", name: "dotted_call" },
                { callId: "part", name: "dotted_key" },
            ]),
            textTurn("done"),
        ]);
        const agent = new Agent(ctx, {
            id: "tool-call-scope-collision",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            features: [toolsFeature],
        });

        try {
            await agent.send(ctx, user("run both"), { await: true });
            await agent.waitForIdle();

            expect.soft(dottedCallObserved).toBe("dotted call");
            expect.soft(dottedKeyCallObserved).toBe("dotted key");
        } finally {
            await agent.close();
        }
    });
});

function makeAgents(
    provider: ScriptedProvider,
    persistenceByAgent: Map<string, InMemoryPersistence>,
    features: readonly AgentFeatureConstructor[],
): AgentSystemLocal {
    const managerPersistence = new InMemoryPersistence();
    return new AgentSystemLocal({
        features,
        storage: new AgentStorage({
            kv: directKV(managerPersistence, "agents."),
            persistence: (agentId) => {
                const existing = persistenceByAgent.get(agentId);
                if (existing !== undefined) return existing;
                const created = new InMemoryPersistence();
                persistenceByAgent.set(agentId, created);
                return created;
            },
        }),
        providers: providersOf(provider),
        provider: "scripted",
        models: [],
    });
}

function directKV(persistence: InMemoryPersistence, prefix: string): AgentBaseKV {
    return new AgentBaseKV(persistence, prefix, async (operationCtx, work) => work(operationCtx));
}

function requiredKV(operationCtx: Context): AgentBaseKV {
    const kv = agentBaseKV(operationCtx);
    if (kv === undefined) throw new Error("Expected a scoped AgentBaseKV.");
    return kv;
}

function isGoalWithStatus(value: unknown, status: string): boolean {
    return (
        typeof value === "object" && value !== null && "status" in value && value.status === status
    );
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function toolCallsTurn(
    calls: readonly { readonly callId: string; readonly name: string }[],
): SessionEvent[] {
    return [
        ...calls.flatMap(({ callId, name }) => [
            { type: "toolcall_start", callId, name } as const,
            { type: "toolcall_end", callId, arguments: "{}" } as const,
        ]),
        {
            type: "done",
            state: "tool_call",
            tokens: { input: 1, output: 1 },
        },
    ];
}
