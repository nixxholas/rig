import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBaseKV,
    AgentRef,
    AgentStorage,
    AgentSystemLocal,
    AgentSystemRef,
    defineAgentTool,
    type AgentFeature,
    type AgentFeatureConstructor,
} from "../sources/index.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-agent-system-ref");

function localSystem(
    provider: ScriptedProvider,
    stores: Map<string, InMemoryPersistence>,
    features: readonly AgentFeatureConstructor[] = [],
): AgentSystemLocal {
    const managerDisk = new InMemoryPersistence();
    return new AgentSystemLocal({
        features,
        storage: new AgentStorage({
            kv: new AgentBaseKV(managerDisk, "agents.", async (opCtx, work) => work(opCtx)),
            persistence: (agentId) => {
                const existing = stores.get(agentId);
                if (existing !== undefined) return existing;
                const created = new InMemoryPersistence();
                stores.set(agentId, created);
                return created;
            },
        }),
        providers: providersOf(provider),
        provider: "scripted",
        models: [],
    });
}

/**
 * The reference exists so that code the run loop is waiting for cannot wait for the run loop.
 * These check the shape of that promise: what it hands back, and that its one asynchronous-looking
 * operation returns without the agent having acted.
 */
describe("AgentSystemRef", () => {
    it("hands back a reference rather than the agent itself", async () => {
        const stores = new Map<string, InMemoryPersistence>();
        const system = localSystem(new ScriptedProvider([textTurn("answered")]), stores);
        const ref = new AgentSystemRef(system);

        const created = await ref.create(ctx, "referenced", {});
        const resolved = await ref.resolve(ctx, "referenced");

        expect({
            created: created instanceof AgentRef,
            resolved: resolved instanceof AgentRef,
            id: created.id,
            // Nothing that waits for a run loop is reachable through the reference.
            reachable: Object.getOwnPropertyNames(Object.getPrototypeOf(created)).sort(),
        }).toEqual({
            created: true,
            resolved: true,
            id: "referenced",
            reachable: ["abort", "compact", "constructor", "id", "send", "steer"],
        });

        await system.delete(ctx, "referenced");
    });

    it("sends and steers through the reference exactly as the agent does", async () => {
        const stores = new Map<string, InMemoryPersistence>();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const system = localSystem(provider, stores);
        const ref = new AgentSystemRef(system);

        const agent = await ref.create(ctx, "talker", {});
        await agent.send(ctx, user("hello"));
        await (await system.resolve(ctx, "talker")).waitForIdle();
        await agent.steer(ctx, user("and this"));
        await (await system.resolve(ctx, "talker")).waitForIdle();

        const asked = provider.sessions.flatMap((session) =>
            session.requests.flatMap((request) =>
                request.context.messages.flatMap((message) =>
                    message.role === "user"
                        ? message.content.flatMap((block) =>
                              block.type === "text" ? [block.text] : [],
                          )
                        : [],
                ),
            ),
        );
        await system.delete(ctx, "talker");

        expect(asked).toEqual(["hello", "hello", "and this"]);
    });

    it("returns from a compaction as soon as it is asked for", async () => {
        const stores = new Map<string, InMemoryPersistence>();
        const provider = new ScriptedProvider([textTurn("answered")]);
        const system = localSystem(provider, stores);
        const ref = new AgentSystemRef(system);
        const agent = await ref.create(ctx, "compacting", {});
        await agent.send(ctx, user("hello"));
        const live = await system.resolve(ctx, "compacting");
        await live.waitForIdle();
        const session = provider.sessions[0];
        if (session === undefined) throw new Error("The provider session was not created.");
        session.compactionResults = [
            {
                status: "completed",
                preservedMessages: [],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
                context: { instructions: "", messages: [] },
            },
        ];

        await agent.compact(ctx);
        const compactedWhenAsked = session.compactions.length;
        await live.waitForIdle();
        const compactedAfterTheTurn = session.compactions.length;
        await system.delete(ctx, "compacting");

        // The request is the whole answer: it resolves before the compaction has run, which is
        // exactly what makes it safe to ask for from inside the turn that would run it.
        expect({ compactedWhenAsked, compactedAfterTheTurn }).toEqual({
            compactedWhenAsked: 0,
            compactedAfterTheTurn: 1,
        });
    });

    it("lets a tool compact its own agent through the reference without deadlocking", async () => {
        const stores = new Map<string, InMemoryPersistence>();
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "a", name: "compact_me" },
                { type: "toolcall_end", callId: "a", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("done"),
        ]);
        let failure: string | undefined;
        const feature: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "self-compacting";
            readonly #agentId: string;

            constructor(agentId: string) {
                this.#agentId = agentId;
            }

            readonly tools = () => [
                defineAgentTool({
                    name: "compact_me",
                    parameters: Type.Object({}),
                    returnType: Type.Object({}),
                    execute: async (callCtx: Context) => {
                        try {
                            await reference.compact(callCtx, this.#agentId);
                        } catch (error: unknown) {
                            failure = error instanceof Error ? error.message : String(error);
                        }
                        return {};
                    },
                    toLLM: () => [{ type: "text", text: "asked" }],
                }),
            ];
        };
        const system = localSystem(provider, stores, [feature]);
        const reference = new AgentSystemRef(system);

        const agent = await system.create(ctx, "self", {});
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        await system.delete(ctx, "self");

        // The direct `compact` refuses this exact call; through the reference it is a request,
        // so the tool returns, the turn ends, and the compaction happens between turns.
        expect(failure).toBeUndefined();
    });

    it("lets a hook abort its own turn through the reference without deadlocking", async () => {
        const stores = new Map<string, InMemoryPersistence>();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const events: string[] = [];
        let asked = false;
        const feature: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "self-aborting";
            readonly #agentId: string;

            constructor(agentId: string) {
                this.#agentId = agentId;
            }

            readonly onEvent = (
                _hookCtx: Context,
                event: { readonly type: string; readonly state?: string },
            ) => {
                if (event.type === "done") events.push(event.state ?? "unknown");
            };

            readonly beforeInference = async (hookCtx: Context) => {
                if (asked) return;
                asked = true;
                // `agent.abort()` here would wait for the loop that is waiting for this hook.
                await reference.abort(hookCtx, this.#agentId);
            };
        };
        const system = localSystem(provider, stores, [feature]);
        const reference = new AgentSystemRef(system);

        const agent = await system.create(ctx, "aborter", {});
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        await system.delete(ctx, "aborter");

        // `agent.abort()` from this hook never returns. Through the reference the hook returns,
        // the loop unwinds, and the turn really was cancelled rather than merely allowed to end.
        expect({ asked, events }).toEqual({ asked: true, events: ["cancelled"] });
    });
});
