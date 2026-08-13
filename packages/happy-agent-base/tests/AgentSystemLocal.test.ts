import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    agentId,
    AgentKV,
    agentConfig,
    agentFeatureConfig,
    AgentStorage,
    AgentSystemLocal,
    AgentSystemRef,
    agentSystem as agentsFromContext,
    type AgentConfig,
    type AgentEnvironment,
    type AgentFeature,
    type AgentFeatureScope,
} from "../sources/index.js";
import { providersOf, queued, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agentSystem-test");

/** A complete environment, since an agent either knows one fully or not at all. */
function environmentOf(workingDirectory: string): AgentEnvironment {
    return {
        osVersion: "25.5.0",
        platform: "darwin",
        workingDirectory,
        shell: "/bin/zsh",
    };
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

function managerKV(persistence: InMemoryPersistence): AgentKV {
    return new AgentKV(persistence, "agentSystem.");
}

describe("AgentSystemLocal", () => {
    it("caches the resolved agent and its store, and tells features which agent they serve", async () => {
        const provider = new ScriptedProvider([]);
        const managerPersistence = new InMemoryPersistence();
        const served: string[] = [];
        const owners: (AgentSystemRef | undefined)[] = [];

        const feature = (featureName: string): AgentFeature =>
            new (class implements AgentFeature {
                readonly name = featureName;

                readonly instructions = (hookCtx: Context, scope: AgentFeatureScope): string => {
                    owners.push(agentsFromContext(hookCtx));
                    served.push(`${this.name}:${scope.agent.id}`);
                    return "";
                };
            })();

        let stores = 0;
        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({
                kv: managerKV(managerPersistence),
                persistence: () => {
                    stores += 1;
                    return new InMemoryPersistence();
                },
            }),
            {
                features: [feature("first"), feature("second")],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );

        const firstAgent = await agentSystem.create(ctx, {
            environment: environmentOf("/tmp/agent-1"),
        });
        const secondAgent = await agentSystem.resolve(ctx, firstAgent.id);
        expect(firstAgent).toBe(secondAgent);
        expect(stores).toBe(1);

        await firstAgent.send(ctx, user("go"), { await: true });
        await firstAgent.waitForIdle();

        // Both features were told the same agent, in the order the collection was given them.
        expect(served).toEqual([`first:${firstAgent.id}`, `second:${firstAgent.id}`]);
        // And each was handed the collection as a reference, never the collection itself.
        expect(owners[0]).toBeInstanceOf(AgentSystemRef);
        expect(owners[1]).toBe(owners[0]);
        await firstAgent.close();
    });

    it("resolves and resumes every durably active agent on start", async () => {
        const activeProvider = new ScriptedProvider([textTurn("resumed")]);
        const idleProvider = new ScriptedProvider([]);
        const activePersistence = new InMemoryPersistence();
        const idlePersistence = new InMemoryPersistence();
        const managerPersistence = new InMemoryPersistence();
        activePersistence.values.set("send.0001", queued(user("continue")));
        // The message was accepted and never answered, so the agent is durably owing an answer.
        activePersistence.values.set("owed", { stage: "inference" });
        // Both agentSystem were created by the previous process, so this one only resolves them.
        managerPersistence.values.set("agentSystem.config.active", {
            environment: environmentOf("/work/active"),
        });
        managerPersistence.values.set("agentSystem.config.idle", {});
        const loaded: string[] = [];

        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({
                kv: managerKV(managerPersistence),
                persistence: (id) => {
                    loaded.push(id);
                    return id === "active" ? activePersistence : idlePersistence;
                },
            }),
            {
                features: [],
                providers: providersOf(activeProvider),
                provider: "scripted",
                models: [],
            },
        );

        await agentSystem.resolve(ctx, "idle");
        const active = await agentSystem.resolve(ctx, "active");
        await active.waitForIdle();

        // The active one was resumed by the start itself; the idle one waited to be asked for.
        expect(loaded).toEqual(["active", "idle"]);
        expect(activeProvider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("continue"),
        ]);
        expect(idleProvider.sessions).toHaveLength(0);
        await active.close();
        await (await agentSystem.resolve(ctx, "idle")).close();
    });

    it("resolves agentSystem automatically for session operations", async () => {
        const provider = new ScriptedProvider([textTurn("sent"), textTurn("steered")]);
        const persistence = new InMemoryPersistence();
        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => persistence,
            }),
            { features: [], providers: providersOf(provider), provider: "scripted", models: [] },
        );

        const created = await agentSystem.create(ctx, {});
        await agentSystem.send(ctx, created.id, user("send"), { await: true });
        const agent = await agentSystem.resolve(ctx, created.id);
        await agent.waitForIdle();
        await agentSystem.steer(ctx, created.id, user("steer"), { await: true });
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.requests).toHaveLength(2);
        expect(session?.requests[0]?.context.messages[0]).toEqual(user("send"));
        expect(session?.requests[1]?.context.messages.at(-1)).toEqual(user("steer"));

        session?.compactionResults.push({
            status: "completed",
            preservedMessages: [],
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
            },
            context: { instructions: "", messages: [] },
        });
        await agentSystem.compact(ctx, created.id, { await: true });
        expect(session?.compactions).toHaveLength(1);

        await agentSystem.abort(ctx, created.id);
        await agent.close();
    });
});

describe("AgentSystemLocal configuration", () => {
    /**
     * A collection over the given manager storage, with one feature that records what each
     * agent's configuration looks like from inside that agent's own hooks. The feature instance
     * is shared, so the configuration reaches it through the context of the agent it is running
     * for rather than through its construction.
     */
    async function collectionOf(
        managerPersistence: InMemoryPersistence,
        seen: AgentConfig[],
        settings: (Record<string, unknown> | undefined)[],
        provider: ScriptedProvider = new ScriptedProvider([]),
    ): Promise<AgentSystemLocal> {
        const recorder: AgentFeature = new (class implements AgentFeature {
            readonly name = "recorder";

            instructions(hookCtx: Context): string {
                const config = agentConfig(hookCtx);
                if (config !== undefined) seen.push(config);
                settings.push(agentFeatureConfig(hookCtx, "recorder"));
                return "";
            }
        })();
        return await AgentSystemLocal.create(
            ctx,
            new AgentStorage({
                kv: managerKV(managerPersistence),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                features: [recorder],
                providers: providersOf(provider),
                provider: "scripted",
                models: [],
            },
        );
    }

    const config: AgentConfig = {
        environment: environmentOf("/work"),
        features: { recorder: { verbosity: "high" } },
    };

    it("carries the created configuration to every feature and keeps it across a restart", async () => {
        const managerPersistence = new InMemoryPersistence();
        const seen: AgentConfig[] = [];
        const settings: (Record<string, unknown> | undefined)[] = [];
        const agentSystem = await collectionOf(
            managerPersistence,
            seen,
            settings,
            new ScriptedProvider([textTurn("first"), textTurn("second")]),
        );

        const agent = await agentSystem.create(ctx, config);
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        expect(seen).toEqual([config]);
        // A feature sees only its own opaque entry, which the collection never interprets.
        expect(settings).toEqual([{ verbosity: "high" }]);
        expect(await agentSystem.config(ctx, agent.id)).toEqual(config);
        await agent.close();

        // A fresh collection over the same storage resolves the very same agent.
        const restarted = await collectionOf(
            managerPersistence,
            seen,
            settings,
            new ScriptedProvider([textTurn("third")]),
        );
        const resolved = await restarted.resolve(ctx, agent.id);
        await resolved.send(ctx, user("again"), { await: true });
        await resolved.waitForIdle();
        expect(seen).toEqual([config, config]);
        await resolved.close();
    });

    it("refuses to resolve an agent that was never created", async () => {
        const agentSystem = await collectionOf(new InMemoryPersistence(), [], []);
        await expect(agentSystem.resolve(ctx, "missing")).rejects.toThrow(
            'Agent "missing" has not been created.',
        );
        expect(await agentSystem.config(ctx, "missing")).toBeUndefined();
    });

    it("rejects a configuration that does not match the schema", async () => {
        const agentSystem = await collectionOf(new InMemoryPersistence(), [], []);
        await expect(
            agentSystem.create(ctx, {
                // An environment is all or nothing: a partial one is not a configuration.
                environment: { platform: "darwin" },
            } as unknown as AgentConfig),
        ).rejects.toThrow("is not valid.");
    });
});

describe("AgentSystemLocal shared features", () => {
    /** A feature instance that records, per agent, everything it was told from the context. */
    class SharedRecorder implements AgentFeature {
        static readonly instances: SharedRecorder[] = [];

        readonly name = "shared-recorder";
        /** Which agents this one instance served, in the order it first saw them. */
        readonly served: string[] = [];
        /** The configuration each of those agents was created with, as the hook was told it. */
        readonly configurations: (AgentConfig | undefined)[] = [];

        constructor() {
            SharedRecorder.instances.push(this);
        }

        readonly instructions = (hookCtx: Context, scope: AgentFeatureScope): string => {
            const id = scope.agent.id;
            if (!this.served.includes(id)) {
                this.served.push(id);
                this.configurations.push(agentConfig(hookCtx));
            }
            return `shared for ${id}`;
        };
    }

    async function collectionOf(
        provider: ScriptedProvider,
        features: readonly AgentFeature[],
    ): Promise<AgentSystemLocal> {
        return await AgentSystemLocal.create(
            ctx,
            new AgentStorage({
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            { features, providers: providersOf(provider), provider: "scripted", models: [] },
        );
    }

    it("gives every agent the one instance the collection was built with", async () => {
        SharedRecorder.instances.length = 0;
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agentSystem = await collectionOf(provider, [new SharedRecorder()]);

        const first = await agentSystem.create(ctx, {});
        const second = await agentSystem.create(ctx, {});

        // One instance for the whole collection, serving both agents.
        expect(SharedRecorder.instances).toHaveLength(1);
        expect(first.feature("shared-recorder")).toBe(second.feature("shared-recorder"));

        // That instance serves both agents, and its instructions open every prompt.
        await first.send(ctx, user("first"), { await: true });
        await first.waitForIdle();
        await second.send(ctx, user("second"), { await: true });
        await second.waitForIdle();
        expect(SharedRecorder.instances[0]?.served).toEqual([first.id, second.id]);
        expect(provider.sessions.map((session) => session.options.instructions)).toEqual([
            `shared for ${first.id}`,
            `shared for ${second.id}`,
        ]);

        await first.close();
        await second.close();
    });

    it("gives a feature one store shared by every agent, beside a store of its own", async () => {
        /** A feature that leaves a note for whichever agent runs next. */
        class Postbox implements AgentFeature {
            readonly name = "postbox";
            /** What each agent found in the shared store, and in its own, before writing. */
            readonly found: { shared: unknown; own: unknown }[] = [];

            readonly instructions = async (
                hookCtx: Context,
                scope: AgentFeatureScope,
            ): Promise<string> => {
                this.found.push({
                    shared: await scope.sharedKV.read(hookCtx, "note"),
                    own: await scope.kv.read(hookCtx, "note"),
                });
                await scope.sharedKV.write(hookCtx, "note", `from ${scope.agent.id}`);
                await scope.kv.write(hookCtx, "note", "mine");
                return "";
            };
        }
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const postbox = new Postbox();
        const agentSystem = await collectionOf(provider, [postbox]);

        const first = await agentSystem.create(ctx, {});
        await first.send(ctx, user("first"), { await: true });
        await first.waitForIdle();
        const second = await agentSystem.create(ctx, {});
        await second.send(ctx, user("second"), { await: true });
        await second.waitForIdle();

        // The second agent reads what the first left in the shared store, and nothing in its own.
        expect(postbox.found).toEqual([
            { shared: undefined, own: undefined },
            { shared: `from ${first.id}`, own: undefined },
        ]);
        await first.close();
        await second.close();
    });

    it("hands features the collection as a reference rather than itself", async () => {
        let seen: unknown;
        class Peek implements AgentFeature {
            readonly name = "peek";
            readonly instructions = (hookCtx: Context): string => {
                seen = agentsFromContext(hookCtx);
                return "";
            };
        }
        const agentSystem = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            {
                features: [new Peek()],
                providers: providersOf(new ScriptedProvider([textTurn("answer")])),
                provider: "scripted",
                models: [],
            },
        );

        const agent = await agentSystem.create(ctx, {});
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(seen).toBeInstanceOf(AgentSystemRef);
        // Nothing that ends an agent's life, or waits for one, is reachable from inside.
        expect(Object.getOwnPropertyNames(Object.getPrototypeOf(seen)).sort()).toEqual([
            "abort",
            "compact",
            "config",
            "constructor",
            "create",
            "models",
            "resolve",
            "send",
            "steer",
        ]);
        await agent.close();
    });
});
