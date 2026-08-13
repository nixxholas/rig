import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { asyncLock, createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    Agent,
    agentKV,
    AgentKV,
    defineAgentTool,
    type AgentFeature,
} from "../../sources/index.js";
import { providersOf, sharedKV, textTurn, user } from "../gym/fixtures.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider } from "../gym/ScriptedProvider.js";

const ctx = createRootContext().named("feature-consistency-races-test");

describe("feature consistency races", () => {
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
        const agent = await Agent.create(ctx, {
            id: "feature-scope-collision",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
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
            shouldReviewInAutoMode: () => false,
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
            shouldReviewInAutoMode: () => false,
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
        const agent = await Agent.create(ctx, {
            id: "tool-call-scope-collision",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
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

function directKV(persistence: InMemoryPersistence, prefix: string): AgentKV {
    return new AgentKV(persistence, prefix);
}

function requiredKV(operationCtx: Context): AgentKV {
    const kv = agentKV(operationCtx);
    if (kv === undefined) throw new Error("Expected a scoped AgentKV.");
    return kv;
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
