import { createId } from "@paralleldrive/cuid2";
import type { SessionMessage, SessionUserMessage } from "@slopus/happy-providers";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { Agent } from "./Agent.js";
import { type AgentBaseAwaitOptions, type AgentBaseMessageOptions } from "./AgentBase.js";
import type { AgentKV } from "./AgentKV.js";
import type { AgentPersistence } from "./AgentPersistence.js";
import { agentBaseWithStoreStill } from "./AgentBaseStoreLock.js";
import { agentConfigSchema, withAgentConfig, type AgentConfig } from "./AgentConfig.js";
import type { AgentFeature } from "./AgentFeature.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AgentStorage } from "./AgentStorage.js";
import type { AgentInitialContext, AgentSystem } from "./AgentSystem.js";
import { withAgentSystem } from "./AgentSystemContext.js";
import { AgentSystemRef } from "./AgentSystemRef.js";

/** Everything `AgentSystemLocal` needs to build and run the agents in its collection. */
export interface AgentSystemLocalOptions {
    /**
     * The features every agent in this collection runs with, given as instances the caller has
     * already built and ready to serve. One instance serves the whole collection: a hook is told
     * which agent it is running for by the scope it is handed, so any per-agent state a feature
     * keeps in memory has to be keyed by that ID rather than held as a single value.
     */
    readonly features?: readonly AgentFeature[];
    /** The registry providers are resolved from when an agent is built. */
    readonly providers: AgentProviders;
    /** The registry ID of the provider new agents are created with. */
    readonly provider: string;
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];
}

/**
 * The `AgentSystem` backed by this process: it lazily builds and owns the `Agent` instances for
 * the identities its storage holds. Concurrent resolutions of the same ID share one load, while a
 * failed load is forgotten so a later resolution can retry.
 *
 * Identity is durable and shared, so more than one live collection can be working over one
 * storage. Everything below therefore serializes per agent rather than per collection — a
 * collection-wide lock would make one agent's feature load block every other agent, including one
 * that load itself resolves — and treats storage, not memory, as the authority on who exists.
 *
 * This is the owner's handle, and some of what it offers waits for an agent to reach a point only
 * that agent's run loop can bring it to. Hand an `AgentSystemRef` to anything running inside an
 * agent instead.
 */
export class AgentSystemLocal implements AgentSystem {
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];

    /**
     * What this collection looks like from inside one of its agents, and the only form of it a
     * derived context ever carries.
     */
    readonly #ref: AgentSystemRef = new AgentSystemRef(this);
    /** The collection's feature instances, every one of them serving every agent it builds. */
    readonly #features: readonly AgentFeature[];
    /** Where the collection's identities, configuration, and per-agent state are durable. */
    readonly #storage: AgentStorage;
    /** The registry providers are resolved from when an agent is built. */
    readonly #providers: AgentProviders;
    /** The registry ID of the provider new agents are created with. */
    readonly #provider: string;
    /** The configuration each identity was created with. */
    readonly #configs: AgentKV;
    /**
     * The root of the store features share across the collection. Each feature works under its
     * own scope of it, which is where anything outliving one agent's conversation belongs.
     */
    readonly #sharedFeatureKV: AgentKV;
    /** The live `Agent` instances this process has built, keyed by identity. */
    readonly #agents = new Map<string, Agent>();
    // One agent has one store for the life of the collection, so inspecting an agent's durable
    // work and running that agent never end up looking at two different stores.
    readonly #persistences = new Map<string, AgentPersistence>();
    /** Per-agent locks handed out by `#lockFor`, created lazily the first time an ID is touched. */
    readonly #locks = new Map<string, AsyncLock>();

    /**
     * Bring up a collection over one storage and carry on where the last process left off.
     *
     * A collection is not a passive registry that happens to be asked for agents later: whatever
     * was running when the previous process ended is still owed an answer, and this is what
     * makes it happen. Every identity the storage holds is examined, and each one that owes work
     * is resolved and resumed, so by the time this returns the collection is not merely built
     * but running. An identity another owner is still creating is left alone, since until that
     * creation commits there is no agent to resume.
     */
    static async create(
        ctx: Context,
        storage: AgentStorage,
        config: AgentSystemLocalOptions,
    ): Promise<AgentSystemLocal> {
        const system = new AgentSystemLocal(storage, config);
        await system.#start(ctx);
        return system;
    }

    /**
     * Wire this collection to its storage, providers, and feature configuration, without reading
     * any of it. Private: a collection is brought up by `create`, which also resumes the work
     * the storage was left holding — building one without that is building half of it.
     */
    private constructor(storage: AgentStorage, options: AgentSystemLocalOptions) {
        this.#features = options.features ?? [];
        this.#storage = storage;
        this.#providers = options.providers;
        this.#provider = options.provider;
        this.models = [...options.models];
        this.#configs = storage.kv.scoped("config");
        this.#sharedFeatureKV = storage.kv.scoped("features");
    }

    /**
     * Create an agent with the configuration it keeps for its whole life, and resolve it. The
     * identity is allocated here and nowhere else: it is a cuid2, globally unique, so a new
     * agent never lands on an identity that already exists or on a store something else wrote.
     * The configuration is persisted before the agent runs, so every later process resolves the
     * agent exactly as it was created.
     *
     * Nothing here is ever undone: an agent whose features refuse to load leaves an identity
     * that exists, is resolvable, and will be built the next time something wants it. The
     * alternative — writing a provisional identity and taking it back when the build fails —
     * has to get the taking-back right in the presence of crashes and other owners, and a
     * compensation that can itself fail is not a guarantee.
     */
    async create(
        ctx: Context,
        config: AgentConfig,
        initialContext?: AgentInitialContext,
    ): Promise<Agent> {
        const agentId = createId();
        if (!Value.Check(agentConfigSchema, config)) {
            throw new Error(`The configuration for agent "${agentId}" is not valid.`);
        }
        // The caller keeps its own object, and may go on editing it. What was created is what
        // was passed at this moment, so storage and this agent's context both get a copy.
        const owned = structuredClone(config);
        return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
            await this.#configs.write(lockCtx, agentId, owned);
            if (initialContext !== undefined) {
                await this.#seedInitialContext(lockCtx, agentId, initialContext.messages);
            }
            const agent = await this.#instantiate(lockCtx, agentId, owned);
            if (agent === undefined) throw new Error(`Agent "${agentId}" could not be built.`);
            return agent;
        });
    }

    /**
     * Close an agent and release its identity, so the same ID can be created again. Used to undo
     * a creation whose follow-up work failed; an ID that was never created is left alone.
     *
     * What the agent wrote is left where it is. The close finishes first, so the store holds a
     * whole conversation rather than a truncated one, and that record is worth more here than the
     * space it takes: whoever deleted the agent may still want to know what it did. The next
     * identity created under this ID starts from an empty store all the same, because creation is
     * what clears it.
     */
    async delete(ctx: Context, agentId: string): Promise<void> {
        await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
            const agent = this.#agents.get(agentId);
            this.#agents.delete(agentId);
            await agent?.close();
            await this.#configs.delete(lockCtx, agentId);
            this.#persistences.delete(agentId);
        });
    }

    /** Install a projected conversation before the new agent is started. */
    async #seedInitialContext(
        ctx: Context,
        agentId: string,
        messages: readonly SessionMessage[],
    ): Promise<void> {
        if (messages.length === 0) return;
        const persistence = this.#persistenceFor(agentId);
        await agentBaseWithStoreStill(ctx, persistence, (storeCtx) =>
            persistence.transaction(storeCtx, async (txCtx) => {
                await persistence.append(txCtx, {
                    type: "compaction",
                    messages: structuredClone(messages),
                });
            }),
        );
    }

    /** The configuration an agent was created with, or undefined when there is no such agent. */
    async config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        const stored = await this.#configs.read(ctx, agentId);
        if (stored === undefined) return undefined;
        if (!Value.Check(agentConfigSchema, stored)) {
            throw new Error(`The stored configuration of agent "${agentId}" is not valid.`);
        }
        return stored;
    }

    /**
     * The live agent for an ID, loading and starting it if this process has not seen it yet.
     * Concurrent resolutions of the same ID share one load.
     */
    async resolve(ctx: Context, agentId: string): Promise<Agent> {
        const existing = this.#agents.get(agentId);
        if (existing !== undefined) return existing;

        return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
            const resolved = this.#agents.get(agentId);
            if (resolved !== undefined) return resolved;

            const config = await this.config(lockCtx, agentId);
            if (config === undefined) {
                throw new Error(`Agent "${agentId}" has not been created.`);
            }
            const agent = await this.#instantiate(lockCtx, agentId, config);
            if (agent === undefined) throw new Error(`Agent "${agentId}" could not be built.`);
            // Building an agent takes as long as its features do, and identity is not this
            // collection's to hold still for that: another owner may have deleted the ID, or a
            // creation this resolution overtook may have rolled it back. Handing back an agent
            // for an identity that no longer exists strands its caller with a live object no
            // restart would ever reproduce, so the answer is checked before it is given.
            if ((await this.config(lockCtx, agentId)) === undefined) {
                this.#agents.delete(agentId);
                await agent.close();
                throw new Error(`Agent "${agentId}" was deleted while it was being resolved.`);
            }
            return agent;
        });
    }

    /**
     * Build one agent and put it to work. Called with the agent's lock held, and only for an ID
     * that has no live instance yet.
     */
    async #instantiate(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
        onlyIfActive = false,
    ): Promise<Agent | undefined> {
        const agentCtx = withAgentConfig(withAgentSystem(ctx, this.#ref), config);
        const options = {
            id: agentId,
            providers: this.#providers,
            provider: this.#provider,
            persistence: this.#persistenceFor(agentId),
            sharedKV: this.#sharedFeatureKV,
            // The collection's features come first, so the instructions they contribute — the
            // system prompt above all — open every agent's prompt.
            features: this.#features,
        };
        // An identity built here may already have durable state — this is the path a restart
        // resolves through — so the agent is loaded rather than created, and knows whether it
        // has work left before anything asks it. Bringing a collection up asks only for the
        // agents that do; anything else resolving an agent wants it whether it owes work or not.
        const agent = onlyIfActive
            ? await Agent.loadActive(agentCtx, options)
            : await Agent.load(agentCtx, options);
        if (agent === undefined) return undefined;
        agent.start();
        this.#agents.set(agentId, agent);
        return agent;
    }

    /**
     * Resolve and resume every agent that has work left from before this process started.
     *
     * The active index is a fast answer, not the authority. It is written by a live run and can
     * Every identity the storage holds is asked whether it has work left, and the ones that do
     * are built and set going. The question is one key in the agent's own store, and only the
     * agent answers it: the collection keeps no index of its own to go stale, and an identity is
     * never dismissed on the strength of something written about it elsewhere.
     *
     * Building the agent is all this does. An agent picks its own work back up when it is
     * loaded, so the collection has only to bring the right ones into existence.
     */
    async #start(ctx: Context): Promise<void> {
        const created = await this.#configs.list(ctx);
        await Promise.all(
            created.map(async ({ key: agentId, value }) => {
                if (!Value.Check(agentConfigSchema, value)) return;
                await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
                    if (this.#agents.has(agentId)) return;
                    await this.#instantiate(lockCtx, agentId, value, true);
                });
            }),
        );
    }

    /** The durable store for one agent, created once and reused for the life of the collection. */
    #persistenceFor(agentId: string): AgentPersistence {
        const existing = this.#persistences.get(agentId);
        if (existing !== undefined) return existing;
        const created = this.#storage.persistence(agentId);
        this.#persistences.set(agentId, created);
        return created;
    }

    /**
     * The lock serializing this collection's work on one identity. It is per agent because the
     * work it guards — building an agent, which loads every feature — may itself resolve another
     * agent from this same collection, and a collection-wide lock would deadlock on it.
     */
    #lockFor(agentId: string): AsyncLock {
        const existing = this.#locks.get(agentId);
        if (existing !== undefined) return existing;
        const created = asyncLock({ reentry: "block" });
        this.#locks.set(agentId, created);
        return created;
    }

    /** Queue a steered message for an agent. */
    async steer(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        const agent = await this.resolve(ctx, agentId);
        await agent.steer(ctx, message, options);
    }

    /** Queue a message for an agent. */
    async send(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        const agent = await this.resolve(ctx, agentId);
        await agent.send(ctx, message, options);
    }

    /** Cancel an agent's active turn, leaving its queued messages durable for the next one. */
    async abort(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void> {
        await (await this.resolve(ctx, agentId)).abort(ctx, options);
    }

    /** Ask an agent for its conversation to be replaced by the provider's summary of it. */
    async compact(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void> {
        await (await this.resolve(ctx, agentId)).compact(ctx, options);
    }
}
