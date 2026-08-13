import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    agentId,
    AgentBaseKV,
    agentConfig,
    agentFeatureConfig,
    AgentStorage,
    AgentSystemLocal,
    AgentSystemRef,
    agentSystem as agentsFromContext,
    type AgentConfig,
    type AgentEnvironment,
    type AgentFeature,
    type AgentFeatureConstructor,
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

function managerKV(persistence: InMemoryPersistence): AgentBaseKV {
    return new AgentBaseKV(persistence, "agentSystem.", async (operationCtx, work) =>
        work(operationCtx),
    );
}

describe("AgentSystemLocal", () => {
    it("loads feature classes in parallel and caches the resolved agent", async () => {
        const provider = new ScriptedProvider([]);
        const managerPersistence = new InMemoryPersistence();
        const started: string[] = [];
        const owners: AgentSystemRef[] = [];
        const releases: (() => void)[] = [];

        const feature = (name: string): AgentFeatureConstructor =>
            class implements AgentFeature {
                readonly name = name;
                readonly agentId: string;

                constructor(agentId: string) {
                    this.agentId = agentId;
                }

                async load(loadCtx: Context): Promise<void> {
                    const owner = agentsFromContext(loadCtx);
                    if (owner !== undefined) owners.push(owner);
                    started.push(`${this.name}:${this.agentId}`);
                    await new Promise<void>((resolve) => releases.push(resolve));
                }
            };

        let optionLoads = 0;
        const agentSystem = new AgentSystemLocal({
            features: [feature("first"), feature("second")],
            storage: new AgentStorage({
                kv: managerKV(managerPersistence),
                persistence: () => {
                    optionLoads += 1;
                    return new InMemoryPersistence();
                },
            }),
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });

        const first = agentSystem.createWithId(ctx, "agent-1", {
            environment: environmentOf("/tmp/agent-1"),
        });
        const second = agentSystem.resolve(ctx, "agent-1");
        await until(() => started.length === 2);

        expect(started).toEqual(["first:agent-1", "second:agent-1"]);
        releases.forEach((release) => release());

        const [firstAgent, secondAgent] = await Promise.all([first, second]);
        expect(firstAgent).toBe(secondAgent);
        expect(optionLoads).toBe(1);
        // Both loads were handed the very same reference, and never the collection itself.
        expect(owners).toHaveLength(2);
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
        managerPersistence.values.set("agentSystem.active.active", true);
        // Both agentSystem were created by the previous process, so this one only resolves them.
        managerPersistence.values.set("agentSystem.config.active", {
            environment: environmentOf("/work/active"),
        });
        managerPersistence.values.set("agentSystem.config.idle", {});
        const loaded: string[] = [];

        const agentSystem = new AgentSystemLocal({
            features: [],
            storage: new AgentStorage({
                kv: managerKV(managerPersistence),
                persistence: (agentId) => {
                    loaded.push(agentId);
                    return agentId === "active" ? activePersistence : idlePersistence;
                },
            }),
            providers: providersOf(activeProvider),
            provider: "scripted",
            models: [],
        });

        await agentSystem.resolve(ctx, "idle");
        await agentSystem.start(ctx);
        const active = await agentSystem.resolve(ctx, "active");
        await active.waitForIdle();

        expect(loaded).toEqual(["idle", "active"]);
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
        const agentSystem = new AgentSystemLocal({
            features: [],
            storage: new AgentStorage({
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => persistence,
            }),
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });

        await agentSystem.createWithId(ctx, "agent-1", {});
        await agentSystem.send(ctx, "agent-1", user("send"), { await: true });
        const agent = await agentSystem.resolve(ctx, "agent-1");
        await agent.waitForIdle();
        await agentSystem.steer(ctx, "agent-1", user("steer"), { await: true });
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
        await agentSystem.compact(ctx, "agent-1", { await: true });
        expect(session?.compactions).toHaveLength(1);

        await agentSystem.abort(ctx, "agent-1");
        await agent.close();
    });
});

describe("AgentSystemLocal configuration", () => {
    /** A collection over the given manager storage, with one recording feature. */
    function collectionOf(
        managerPersistence: InMemoryPersistence,
        seen: AgentConfig[],
        settings: (Record<string, unknown> | undefined)[],
    ): AgentSystemLocal {
        const recorder: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "recorder";

            load(loadCtx: Context): Promise<void> {
                const config = agentConfig(loadCtx);
                if (config !== undefined) seen.push(config);
                settings.push(agentFeatureConfig(loadCtx, "recorder"));
                return Promise.resolve();
            }
        };
        return new AgentSystemLocal({
            features: [recorder],
            storage: new AgentStorage({
                kv: managerKV(managerPersistence),
                persistence: () => new InMemoryPersistence(),
            }),
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });
    }

    const config: AgentConfig = {
        environment: environmentOf("/work"),
        features: { recorder: { verbosity: "high" } },
    };

    it("carries the created configuration to every feature and keeps it across a restart", async () => {
        const managerPersistence = new InMemoryPersistence();
        const seen: AgentConfig[] = [];
        const settings: (Record<string, unknown> | undefined)[] = [];
        const agentSystem = collectionOf(managerPersistence, seen, settings);

        const agent = await agentSystem.createWithId(ctx, "agent-1", config);
        expect(seen).toEqual([config]);
        // A feature sees only its own opaque entry, which the collection never interprets.
        expect(settings).toEqual([{ verbosity: "high" }]);
        expect(await agentSystem.config(ctx, "agent-1")).toEqual(config);
        await agent.close();

        // A fresh collection over the same storage resolves the very same agent.
        const restarted = collectionOf(managerPersistence, seen, settings);
        const resolved = await restarted.resolve(ctx, "agent-1");
        expect(seen).toEqual([config, config]);
        await resolved.close();
    });

    it("refuses to resolve an agent that was never created", async () => {
        const agentSystem = collectionOf(new InMemoryPersistence(), [], []);
        await expect(agentSystem.resolve(ctx, "missing")).rejects.toThrow(
            'Agent "missing" has not been created.',
        );
        expect(await agentSystem.config(ctx, "missing")).toBeUndefined();
    });

    it("refuses to create the same agent twice", async () => {
        const agentSystem = collectionOf(new InMemoryPersistence(), [], []);
        const agent = await agentSystem.createWithId(ctx, "agent-1", {});
        await expect(agentSystem.createWithId(ctx, "agent-1", config)).rejects.toThrow(
            'Agent "agent-1" already exists.',
        );
        // The original configuration is untouched.
        expect(await agentSystem.config(ctx, "agent-1")).toEqual({});
        await agent.close();
    });

    it("rejects a configuration that does not match the schema", async () => {
        const agentSystem = collectionOf(new InMemoryPersistence(), [], []);
        await expect(
            agentSystem.createWithId(ctx, "agent-1", {
                // An environment is all or nothing: a partial one is not a configuration.
                environment: { platform: "darwin" },
            } as unknown as AgentConfig),
        ).rejects.toThrow('The configuration for agent "agent-1" is not valid.');
        expect(await agentSystem.config(ctx, "agent-1")).toBeUndefined();
    });
});

describe("AgentSystemLocal individual and shared features", () => {
    /** A shared feature that records, per agent, everything it was told from the context. */
    class SharedRecorder implements AgentFeature {
        static readonly instances: SharedRecorder[] = [];
        static readonly loads: (AgentConfig | undefined)[] = [];

        readonly name = "shared-recorder";
        /** Which agents this one instance served, in the order it first saw them. */
        readonly served: string[] = [];

        constructor() {
            SharedRecorder.instances.push(this);
        }

        load(loadCtx: Context): Promise<void> {
            // A shared feature belongs to the collection, so it must not be handed one agent's
            // configuration at load time.
            SharedRecorder.loads.push(agentConfig(loadCtx));
            return Promise.resolve();
        }

        readonly instructions = (hookCtx: Context): string => {
            const id = agentId(hookCtx) ?? "unknown";
            if (!this.served.includes(id)) this.served.push(id);
            return `shared for ${id}`;
        };
    }

    /** An individual feature: one instance per agent, configured by that agent alone. */
    class IndividualRecorder implements AgentFeature {
        static readonly instances: IndividualRecorder[] = [];

        readonly name = "individual-recorder";
        readonly agentId: string;
        settings: Record<string, unknown> | undefined;

        constructor(agentId: string) {
            this.agentId = agentId;
            IndividualRecorder.instances.push(this);
        }

        load(loadCtx: Context): Promise<void> {
            this.settings = agentFeatureConfig(loadCtx, this.name);
            return Promise.resolve();
        }

        readonly instructions = (): string => `individual for ${this.agentId}`;
    }

    function collectionOf(provider: ScriptedProvider): AgentSystemLocal {
        return new AgentSystemLocal({
            features: [IndividualRecorder],
            sharedFeatures: [SharedRecorder],
            storage: new AgentStorage({
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
    }

    it("gives every agent one shared instance and an individual instance of its own", async () => {
        SharedRecorder.instances.length = 0;
        SharedRecorder.loads.length = 0;
        IndividualRecorder.instances.length = 0;
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agentSystem = collectionOf(provider);

        const first = await agentSystem.createWithId(ctx, "agent-1", {
            features: { "individual-recorder": { objective: "first" } },
        });
        const second = await agentSystem.createWithId(ctx, "agent-2", {
            features: { "individual-recorder": { objective: "second" } },
        });

        // One shared instance for the collection, loaded once, without any agent's configuration.
        expect(SharedRecorder.instances).toHaveLength(1);
        expect(SharedRecorder.loads).toEqual([undefined]);
        expect(first.feature("shared-recorder")).toBe(second.feature("shared-recorder"));

        // One individual instance per agent, each configured by the agent it belongs to.
        expect(IndividualRecorder.instances.map((feature) => feature.agentId)).toEqual([
            "agent-1",
            "agent-2",
        ]);
        expect(IndividualRecorder.instances.map((feature) => feature.settings)).toEqual([
            { objective: "first" },
            { objective: "second" },
        ]);
        expect(first.feature("individual-recorder")).not.toBe(
            second.feature("individual-recorder"),
        );

        // The shared instance serves both agents, and its instructions open every prompt.
        await first.send(ctx, user("first"), { await: true });
        await first.waitForIdle();
        await second.send(ctx, user("second"), { await: true });
        await second.waitForIdle();
        expect(SharedRecorder.instances[0]?.served).toEqual(["agent-1", "agent-2"]);
        expect(provider.sessions.map((session) => session.options.instructions)).toEqual([
            "shared for agent-1\n\nindividual for agent-1",
            "shared for agent-2\n\nindividual for agent-2",
        ]);

        await first.close();
        await second.close();
    });

    it("hands features the collection as a reference rather than itself", async () => {
        let seen: unknown;
        class Peek implements AgentFeature {
            readonly name = "peek";
            load(loadCtx: Context): Promise<void> {
                seen = agentsFromContext(loadCtx);
                return Promise.resolve();
            }
        }
        const agentSystem = new AgentSystemLocal({
            sharedFeatures: [Peek],
            storage: new AgentStorage({
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });

        const agent = await agentSystem.createWithId(ctx, "agent-1", {});

        expect(seen).toBeInstanceOf(AgentSystemRef);
        // Nothing that ends an agent's life, or waits for one, is reachable from inside.
        expect(Object.getOwnPropertyNames(Object.getPrototypeOf(seen)).sort()).toEqual([
            "abort",
            "compact",
            "config",
            "constructor",
            "create",
            "feature",
            "featureState",
            "models",
            "resolve",
            "send",
            "steer",
        ]);
        await agent.close();
    });

    it("retries a shared load that failed, and builds no agent until it succeeds", async () => {
        let failures = 1;
        class FailsOnce implements AgentFeature {
            readonly name = "fails-once";
            load(): Promise<void> {
                if (failures > 0) {
                    failures -= 1;
                    return Promise.reject(new Error("shared load unavailable"));
                }
                return Promise.resolve();
            }
        }
        const agentSystem = new AgentSystemLocal({
            sharedFeatures: [FailsOnce],
            storage: new AgentStorage({
                kv: managerKV(new InMemoryPersistence()),
                persistence: () => new InMemoryPersistence(),
            }),
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });

        await expect(agentSystem.createWithId(ctx, "agent-1", {})).rejects.toThrow(
            "shared load unavailable",
        );
        // The failed creation left no identity behind, so the same ID can be created again.
        expect(await agentSystem.config(ctx, "agent-1")).toBeUndefined();
        const agent = await agentSystem.createWithId(ctx, "agent-1", {});
        expect(agent.feature("fails-once")).toBeDefined();
        await agent.close();
    });
});
