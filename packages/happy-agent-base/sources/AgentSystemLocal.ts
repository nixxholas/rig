import { createId } from "@paralleldrive/cuid2";
import type { SessionMessage, SessionUserMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { Agent } from "./Agent.js";
import { type AgentBaseAwaitOptions, type AgentBaseMessageOptions } from "./AgentBase.js";
import { agentId as agentIdOf } from "./AgentContexts.js";
import type { AgentKV } from "./AgentKV.js";
import type { AgentPersistence } from "./AgentPersistence.js";
import {
    agentConfigSchema,
    ownAgentConfig,
    withAgentConfig,
    type AgentConfig,
} from "./AgentConfig.js";
import type { AgentFeature } from "./AgentFeature.js";
import { cuid2Schema, type AgentMetadata } from "./AgentMetadata.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AgentStorage, AgentStorageLock } from "./AgentStorage.js";
import type { AgentCreateOptions, AgentSystem } from "./AgentSystem.js";
import { withAgentSystem } from "./AgentSystemContext.js";
import { AgentSystemRef } from "./AgentSystemRef.js";

const storedParentSchema = Type.String();

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
 * Work serializes per agent rather than per collection: a collection-wide lock would make one
 * agent's feature load block every other agent, including one that load itself resolves.
 *
 * This is the owner's handle, and some of what it offers waits for an agent to reach a point only
 * that agent's run loop can bring it to. Hand an `AgentSystemRef` to anything running inside an
 * agent instead.
 */
export class AgentSystemLocal implements AgentSystem {
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];
    /** The lifetime context retained by this system and its storage lock. */
    readonly #ctx: Context;

    /**
     * What this collection looks like from inside one of its agents, and the only form of it a
     * derived context ever carries.
     */
    readonly #ref: AgentSystemRef = new AgentSystemRef(this, null);
    /** The collection's feature instances, every one of them serving every agent it builds. */
    readonly #features: readonly AgentFeature[];
    /** Where the collection's identities, configuration, and per-agent state are durable. */
    readonly #storage: AgentStorage;
    /** The registry providers are resolved from when an agent is built. */
    readonly #providers: AgentProviders;
    /** The registry ID of the provider new agents are created with. */
    readonly #provider: string;
    /** Exclusive database-backed ownership of this collection's whole durable store. */
    readonly #storageLock: AgentStorageLock;
    /** The identity index and creation-time config fallback; current config lives with the agent. */
    readonly #configs: AgentKV;
    /** The durable parent of each non-root identity, keyed by child identity. */
    readonly #parents: AgentKV;
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
    /** Public operations admitted before shutdown and therefore allowed to finish. */
    readonly #admitted = new Set<Promise<void>>();
    /** No agent operation is admitted until every feature has finished its beforeStart hook. */
    #lifecycle: "initializing" | "open" | "closing" | "closed" = "initializing";
    /** The shared shutdown, including release of the hard storage lock. */
    #closePromise: Promise<void> | undefined;

    /**
     * Bring up a collection over one storage and carry on where the last process left off.
     *
     * A collection is not a passive registry that happens to be asked for agents later: whatever
     * was running when the previous process ended is still owed an answer, and this is what
     * makes it happen. Every identity the storage holds is examined, and each one that owes work
     * is resolved and resumed, so by the time this returns the collection is not merely built
     * but running.
     */
    static async create(
        ctx: Context,
        storage: AgentStorage,
        config: AgentSystemLocalOptions,
    ): Promise<AgentSystemLocal> {
        const systemCtx = ctx;
        const storageLock = await storage.acquireLock(systemCtx);
        const system = new AgentSystemLocal(systemCtx, storage, storageLock, config);
        try {
            await system.#beforeStart(systemCtx);
            const active = await system.#start(systemCtx);
            system.#lifecycle = "open";
            for (const agent of active) agent.start();
            await system.#afterStart(systemCtx);
            return system;
        } catch (error: unknown) {
            await system.close(systemCtx).catch(() => undefined);
            throw error;
        }
    }

    /**
     * Wire this collection to its storage, providers, and feature configuration, without reading
     * any of it. Private: a collection is brought up by `create`, which also resumes the work
     * the storage was left holding — building one without that is building half of it.
     */
    private constructor(
        ctx: Context,
        storage: AgentStorage,
        storageLock: AgentStorageLock,
        options: AgentSystemLocalOptions,
    ) {
        this.#ctx = ctx;
        this.#features = options.features ?? [];
        this.#storage = storage;
        this.#storageLock = storageLock;
        this.#providers = options.providers;
        this.#provider = options.provider;
        this.models = [...options.models];
        this.#configs = storage.kv.scoped("config");
        this.#parents = storage.kv.scoped("parent");
        this.#sharedFeatureKV = storage.kv.scoped("features");
    }

    /**
     * Stop every live agent, wait for operations already admitted by this owner, and only then
     * release the database lock. Repeated callers join the same shutdown.
     */
    async close(ctx: Context): Promise<void> {
        if (this.#closePromise === undefined) {
            this.#lifecycle = "closing";
            this.#closePromise = this.#shutdown();
        }
        const closing = this.#closePromise;
        const caller = agentIdOf(ctx);
        if (caller !== undefined && this.#agents.has(caller)) {
            void closing.catch(() => undefined);
            throw new Error(
                "Closing the agent system from inside one of its own agents would wait for " +
                    "that agent's turn. Shutdown will finish and release the store after this " +
                    "caller returns.",
            );
        }
        await closing;
    }

    /** The real shutdown barrier, which keeps the hard store lock until every agent is closed. */
    async #shutdown(): Promise<void> {
        try {
            while (this.#admitted.size > 0) {
                await Promise.allSettled(this.#admitted);
            }
            const closed = [...this.#agents.values()].map((agent) => {
                void agent.close().catch(() => undefined);
                return agent.waitForClosed();
            });
            await Promise.allSettled(closed);
            this.#agents.clear();
            this.#persistences.clear();
            this.#locks.clear();
        } finally {
            try {
                await this.#storageLock.release(this.#ctx);
            } finally {
                this.#lifecycle = "closed";
            }
        }
    }

    /**
     * Admit one public operation while this system still owns the store. Shutdown rejects new
     * admissions and waits for every earlier one before releasing the hard lock.
     */
    #admit<Result>(operation: () => Promise<Result>): Promise<Result> {
        if (this.#lifecycle !== "open") {
            return Promise.reject(
                new Error(
                    this.#lifecycle === "initializing"
                        ? "The agent system is not ready."
                        : "The agent system is closed.",
                ),
            );
        }
        let running: Promise<Result>;
        try {
            // Begin synchronously so ownership-transfer boundaries such as create(config) copy
            // caller-owned input before the caller can mutate it after receiving the promise.
            running = operation();
        } catch (error: unknown) {
            return Promise.reject(error);
        }
        const settled = running.then(
            () => undefined,
            () => undefined,
        );
        this.#admitted.add(settled);
        void settled.finally(() => this.#admitted.delete(settled));
        return running;
    }

    /**
     * Create and resolve an agent. Its identity is either a validated caller-supplied cuid2 or
     * allocated here, and the transaction refuses an existing identity rather than overwriting
     * it. Configuration and parentage are persisted before the agent runs, so every later process
     * resolves the same agent; only its metadata may subsequently change.
     *
     * Nothing here is undone: an agent whose features refuse to load leaves an identity that
     * exists, is resolvable, and will be built the next time something wants it. Taking a
     * provisional identity back after a failed build would add a compensation that can itself
     * fail.
     */
    async create(ctx: Context, config: AgentConfig, options?: AgentCreateOptions): Promise<Agent> {
        return await this.#admit(async () => {
            const agentId = options?.id ?? createId();
            if (!Value.Check(cuid2Schema, agentId)) {
                throw new Error("The agent ID must be a cuid2 identity.");
            }
            if (!Value.Check(agentConfigSchema, config)) {
                throw new Error(`The configuration for agent "${agentId}" is not valid.`);
            }
            const parent =
                options?.parent === undefined ? (agentIdOf(ctx) ?? null) : options.parent;
            // The caller keeps its own object, and may go on editing it. What was created is what
            // was passed at this moment, so storage and this agent's context both get a copy.
            const owned = ownAgentConfig(config);
            return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
                if ((await this.#configs.read(lockCtx, agentId)) !== undefined) {
                    throw new Error(`Agent "${agentId}" already exists.`);
                }
                if (parent !== null && (await this.#configs.read(lockCtx, parent)) === undefined) {
                    throw new Error(`Agent "${parent}" has not been created.`);
                }
                await this.#preparePersistence(
                    lockCtx,
                    agentId,
                    owned,
                    options?.initialContext?.messages ?? [],
                );
                await this.#configs.transaction(lockCtx, async (_configs, txCtx) => {
                    if ((await this.#configs.read(txCtx, agentId)) !== undefined) {
                        throw new Error(`Agent "${agentId}" already exists.`);
                    }
                    if (
                        parent !== null &&
                        (await this.#configs.read(txCtx, parent)) === undefined
                    ) {
                        throw new Error(`Agent "${parent}" has not been created.`);
                    }
                    await this.#configs.write(txCtx, agentId, owned);
                    if (parent !== null) await this.#parents.write(txCtx, agentId, parent);
                });
                const agent = await this.#instantiate(lockCtx, agentId, owned);
                if (agent === undefined) throw new Error(`Agent "${agentId}" could not be built.`);
                return agent;
            });
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
        await this.#admit(async () => {
            await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
                const agent = this.#agents.get(agentId);
                this.#agents.delete(agentId);
                await agent?.close();
                await this.#configs.transaction(lockCtx, async (_configs, txCtx) => {
                    await this.#configs.delete(txCtx, agentId);
                    await this.#parents.delete(txCtx, agentId);
                    const children = await this.#parents.list(txCtx);
                    for (const child of children) {
                        if (child.value === agentId) await this.#parents.delete(txCtx, child.key);
                    }
                });
                this.#persistences.delete(agentId);
            });
        });
    }

    /**
     * Atomically clear an earlier incarnation's isolated store and install the new configuration
     * and projected conversation before publishing the identity in the collection index.
     */
    async #preparePersistence(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
        messages: readonly SessionMessage[],
    ): Promise<void> {
        const persistence = this.#persistenceFor(agentId);
        await persistence.transaction(ctx, async (txCtx) => {
            await persistence.clearRecords(txCtx);
            for (const { key } of await persistence.readValues(txCtx, "")) {
                await persistence.deleteValue(txCtx, key);
            }
            await persistence.writeValue(txCtx, "agentConfig", config);
            if (messages.length > 0) {
                await persistence.append(txCtx, {
                    type: "compaction",
                    messages: structuredClone(messages),
                });
            }
        });
    }

    /** The current configuration of an agent, or undefined when there is no such agent. */
    async config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return await this.#admit(async () => await this.#config(ctx, agentId));
    }

    /** Read one stored configuration while its owning operation is already admitted. */
    async #config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        const indexed = await this.#configs.read(ctx, agentId);
        if (indexed === undefined) return undefined;
        const local = await this.#persistenceFor(agentId).readValues(ctx, "agentConfig");
        const stored = local.find(({ key }) => key === "agentConfig")?.value ?? indexed;
        if (!Value.Check(agentConfigSchema, stored)) {
            throw new Error(`The stored configuration of agent "${agentId}" is not valid.`);
        }
        return ownAgentConfig(stored);
    }

    /** Shallow-merge fields into one agent's immutable metadata. */
    async updateMetadata(ctx: Context, agentId: string, update: AgentMetadata): Promise<void> {
        await this.#admit(async () => {
            const agent = await this.#resolve(ctx, agentId);
            await agent.updateMetadata(ctx, update);
        });
    }

    /** The direct children of an existing agent, in durable key order. */
    async childOf(ctx: Context, agentId: string): Promise<readonly string[]> {
        return await this.#admit(async () => {
            await this.#requireAgent(ctx, agentId);
            return (await this.#parents.list(ctx)).flatMap(({ key, value }) =>
                value === agentId ? [key] : [],
            );
        });
    }

    /** The parent of an existing agent, or `null` when it is a root. */
    async parentOf(ctx: Context, agentId: string): Promise<string | null> {
        return await this.#admit(async () => {
            await this.#requireAgent(ctx, agentId);
            const parent = await this.#parents.read(ctx, agentId);
            if (parent === undefined) return null;
            if (!Value.Check(storedParentSchema, parent)) {
                throw new Error(`The stored parent of agent "${agentId}" is not valid.`);
            }
            return parent;
        });
    }

    /** Refuse relationship queries for an identity that has never been created. */
    async #requireAgent(ctx: Context, agentId: string): Promise<void> {
        if ((await this.#config(ctx, agentId)) === undefined) {
            throw new Error(`Agent "${agentId}" has not been created.`);
        }
    }

    /**
     * The live agent for an ID, loading and starting it if this process has not seen it yet.
     * Concurrent resolutions of the same ID share one load.
     */
    async resolve(ctx: Context, agentId: string): Promise<Agent> {
        return await this.#admit(async () => await this.#resolve(ctx, agentId));
    }

    /** Resolve one agent while its owning public operation is already admitted. */
    async #resolve(ctx: Context, agentId: string): Promise<Agent> {
        const existing = this.#agents.get(agentId);
        if (existing !== undefined) return existing;

        return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
            const resolved = this.#agents.get(agentId);
            if (resolved !== undefined) return resolved;

            const config = await this.#config(lockCtx, agentId);
            if (config === undefined) {
                throw new Error(`Agent "${agentId}" has not been created.`);
            }
            const agent = await this.#instantiate(lockCtx, agentId, config);
            if (agent === undefined) throw new Error(`Agent "${agentId}" could not be built.`);
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
        start = true,
    ): Promise<Agent | undefined> {
        const agentCtx = withAgentConfig(
            withAgentSystem(ctx, new AgentSystemRef(this, agentId)),
            config,
        );
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
        const agent = await Agent.load(agentCtx, options);
        if (onlyIfActive && !agent.active) {
            await agent.close();
            return undefined;
        }
        this.#agents.set(agentId, agent);
        if (start) agent.start();
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
    async #start(ctx: Context): Promise<readonly Agent[]> {
        const created = await this.#configs.list(ctx);
        const results = await Promise.allSettled(
            created.map(async ({ key: agentId }) => {
                return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
                    if (this.#agents.has(agentId)) return undefined;
                    const config = await this.#config(lockCtx, agentId);
                    if (config === undefined) return undefined;
                    return await this.#instantiate(lockCtx, agentId, config, true, false);
                });
            }),
        );
        throwFirstStartFailure(results);
        return results.flatMap((result) =>
            result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
        );
    }

    /** Initialize every feature before any active agent is restored or started. */
    async #beforeStart(ctx: Context): Promise<void> {
        const startCtx = withAgentSystem(ctx, this.#ref);
        const results = await Promise.allSettled(
            this.#features.map(async (feature) => await feature.beforeStart?.(startCtx, this.#ref)),
        );
        throwFirstStartFailure(results);
    }

    /** Notify every feature after all active agents have been restored and started. */
    async #afterStart(ctx: Context): Promise<void> {
        const startCtx = withAgentSystem(ctx, this.#ref);
        const results = await Promise.allSettled(
            this.#features.map(async (feature) => await feature.afterStart?.(startCtx, this.#ref)),
        );
        throwFirstStartFailure(results);
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
        await this.#admit(async () => {
            const agent = await this.#resolve(ctx, agentId);
            await agent.steer(ctx, message, options);
        });
    }

    /** Queue a message for an agent. */
    async send(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        await this.#admit(async () => {
            const agent = await this.#resolve(ctx, agentId);
            await agent.send(ctx, message, options);
        });
    }

    /** Cancel an agent's active turn, leaving its queued messages durable for the next one. */
    async abort(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void> {
        await this.#admit(async () => {
            await (await this.#resolve(ctx, agentId)).abort(ctx, options);
        });
    }

    /** Ask an agent for its conversation to be replaced by the provider's summary of it. */
    async compact(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void> {
        await this.#admit(async () => {
            await (await this.#resolve(ctx, agentId)).compact(ctx, options);
        });
    }
}

/** Start every feature even when one fails, then surface the first failure in feature order. */
function throwFirstStartFailure(results: readonly PromiseSettledResult<unknown>[]): void {
    const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
}
