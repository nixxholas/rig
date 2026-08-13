import { createId } from "@paralleldrive/cuid2";
import type { SessionMessage, SessionUserMessage } from "@slopus/happy-providers";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { Agent } from "./Agent.js";
import { type AgentBaseAwaitOptions, type AgentBaseMessageOptions } from "./AgentBase.js";
import type { AgentBaseKV } from "./AgentBaseKV.js";
import type { AgentBasePersistence } from "./AgentBasePersistence.js";
import { agentBaseStoreOwesWork } from "./AgentBasePending.js";
import { agentBaseWithStoreStill } from "./AgentBaseStoreLock.js";
import { agentConfigSchema, withAgentConfig, type AgentConfig } from "./AgentConfig.js";
import type {
    AgentFeature,
    AgentFeatureConstructor,
    SharedAgentFeatureConstructor,
} from "./AgentFeature.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AgentStorage } from "./AgentStorage.js";
import type { AgentInitialContext, AgentSystem } from "./AgentSystem.js";
import { withAgentSystem } from "./AgentSystemContext.js";
import { AgentSystemRef } from "./AgentSystemRef.js";

/** Everything `AgentSystemLocal` needs to build and run the agents in its collection. */
export interface AgentSystemLocalOptions {
    /** Identity allocator; production uses cuid2 and tests may inject a deterministic sequence. */
    readonly createAgentId?: () => string;
    /**
     * Individual features: one instance per agent, built when that agent is. Each may hold the
     * state of the one agent it belongs to and may be configured for it alone, through the
     * agent's own `features` entry — a goal belongs to one conversation, and an agent created
     * without one has none.
     */
    readonly features?: readonly AgentFeatureConstructor[];
    /**
     * Shared features: one instance for the whole collection, given to every agent it builds and
     * placed ahead of the individual ones, so the system prompt opens the instructions. These are
     * the capabilities that are the same wherever they run, and they read the agent a hook is
     * serving from its context rather than from the instance.
     */
    readonly sharedFeatures?: readonly SharedAgentFeatureConstructor[];
    /** Where the collection's identities, configuration, and per-agent state are durable. */
    readonly storage: AgentStorage;
    /** The registry providers are resolved from when an agent is built. */
    readonly providers: AgentProviders;
    /** The registry ID of the provider new agents are created with. */
    readonly provider: string;
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];
}

/** The record that says an identity exists, and which creation it belongs to. */
interface CreationRecord {
    /** The random value that identifies which creation attempt owns this identity. */
    readonly token: string;
    /** True while the creation that claimed this identity has not yet produced an agent. */
    readonly pending?: boolean;
}

/** Thrown inside a rollback that found the identity already belonged to someone else. */
const STALE_ROLLBACK = Symbol("staleRollback");

/** Parse a stored creation record, or undefined when the value is not one. */
function creationRecordOf(value: unknown): CreationRecord | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const token = (value as { token?: unknown }).token;
    if (typeof token !== "string") return undefined;
    return { token, pending: (value as { pending?: unknown }).pending === true };
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

    /** Per-agent feature constructors, instantiated fresh for each agent this collection builds. */
    readonly #featureClasses: readonly AgentFeatureConstructor[];
    /** Identity allocator for new agents; defaults to cuid2. */
    readonly #createAgentId: () => string;
    /**
     * What this collection looks like from inside one of its agents, and the only form of it a
     * derived context ever carries.
     */
    readonly #ref: AgentSystemRef = new AgentSystemRef(this);
    /** The collection's own feature instances, serving every agent it builds. */
    readonly #sharedFeatures: readonly AgentFeature[];
    /** The one load of those instances, shared by every agent that waits for it. */
    #sharedLoad: Promise<void> | undefined;
    /** Where the collection's identities, configuration, and per-agent state are durable. */
    readonly #storage: AgentStorage;
    /** The registry providers are resolved from when an agent is built. */
    readonly #providers: AgentProviders;
    /** The registry ID of the provider new agents are created with. */
    readonly #provider: string;
    /** Which agent identities are worth resuming on the next start. */
    readonly #active: AgentBaseKV;
    /** The configuration each identity was created with. */
    readonly #configs: AgentBaseKV;
    /** Which creation an identity belongs to, and whether that creation has finished. */
    readonly #creations: AgentBaseKV;
    /** The live `Agent` instances this process has built, keyed by identity. */
    readonly #agents = new Map<string, Agent>();
    // One agent has one store for the life of the collection, so inspecting an agent's durable
    // work and running that agent never end up looking at two different stores.
    readonly #persistences = new Map<string, AgentBasePersistence>();
    /** Per-agent locks handed out by `#lockFor`, created lazily the first time an ID is touched. */
    readonly #locks = new Map<string, AsyncLock>();

    /** Wire this collection to its storage, providers, and feature configuration. */
    constructor(options: AgentSystemLocalOptions) {
        this.#createAgentId = options.createAgentId ?? createId;
        this.#featureClasses = options.features ?? [];
        this.#sharedFeatures = (options.sharedFeatures ?? []).map((Feature) => new Feature());
        this.#storage = options.storage;
        this.#providers = options.providers;
        this.#provider = options.provider;
        this.models = [...options.models];
        this.#active = options.storage.kv.scoped("active");
        this.#configs = options.storage.kv.scoped("config");
        this.#creations = options.storage.kv.scoped("creating");
    }

    /**
     * Create an agent with the configuration it keeps for its whole life, and resolve it. The
     * configuration is persisted before the agent runs, so every later process resolves the
     * agent exactly as it was created. Creating an ID that already exists is an error.
     *
     * A creation is two steps and is visible as neither until both are done: the identity is
     * claimed as pending, and only a creation that produced a running agent clears that. An
     * observer that finds a pending identity is told it does not exist yet, rather than being
     * handed an agent whose creation may still roll back underneath it.
     */
    async create(
        ctx: Context,
        config: AgentConfig,
        initialContext?: AgentInitialContext,
    ): Promise<Agent> {
        return await this.createWithId(ctx, this.#createAgentId(), config, initialContext);
    }

    /**
     * Deterministic identity seam for storage recovery tests and importing an externally owned
     * identity. Normal callers, including collaboration, use `create`.
     */
    async createWithId(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
        initialContext?: AgentInitialContext,
    ): Promise<Agent> {
        if (!Value.Check(agentConfigSchema, config)) {
            throw new Error(`The configuration for agent "${agentId}" is not valid.`);
        }
        // The caller keeps its own object, and may go on editing it. What was created is what
        // was passed at this moment, so storage and this agent's context both get a copy.
        const owned = structuredClone(config);
        return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
            const token = randomUUID();
            // The identity is claimed by the write itself rather than by a check before it. A
            // second owner asking the same question at the same moment would get the same
            // answer, and both would believe they had created the agent while storage kept only
            // one configuration — a split brain whose two halves disagree about who it is.
            const claimed = await this.#creations.writeIfAbsent(lockCtx, agentId, {
                token,
                pending: true,
            });
            if (!claimed) {
                throw new Error(`Agent "${agentId}" already exists.`);
            }
            let wroteConfig = false;
            try {
                wroteConfig = await this.#configs.writeIfAbsent(lockCtx, agentId, owned);
                if (!wroteConfig) {
                    throw new Error(`Agent "${agentId}" already exists.`);
                }
                // The ID was free, so anything its store still holds belongs to an identity that
                // was released. This agent is a different agent and starts from nothing: it must
                // not wake up inside its predecessor's conversation, settings, or feature state.
                await this.#wipe(lockCtx, agentId);
                if (initialContext !== undefined) {
                    await this.#seedInitialContext(lockCtx, agentId, initialContext.messages);
                }
                const agent = await this.#instantiate(lockCtx, agentId, owned);
                await this.#creations.write(lockCtx, agentId, { token });
                return agent;
            } catch (error) {
                // A creation that never produced an agent must leave no identity behind. Without
                // this, a later process would resolve a config whose agent was never built, and
                // the caller who saw the failure could not retry the same ID.
                const rollbackFailure = await this.#rollbackCreation(
                    lockCtx,
                    agentId,
                    token,
                    wroteConfig,
                );
                throw rollbackFailure ?? error;
            }
        });
    }

    /**
     * Undo a creation that failed, and report the failure that stopped the undo rather than the
     * one that caused it — a ghost identity nobody can create again or resolve is the worse of
     * the two, so it is what the caller is told about. A failed attempt is retried once for the
     * same reason.
     *
     * The identity is deleted first and the ownership check made afterwards, inside the same
     * atomic step: reading first would decide on a state the deletion could no longer be sure
     * of, and this rollback may have been in flight long enough for the ID to have been released
     * and taken by a genuine successor. Finding that successor rolls the whole step back, so the
     * successor's configuration is never collateral damage.
     */
    async #rollbackCreation(
        ctx: Context,
        agentId: string,
        token: string,
        wroteConfig: boolean,
    ): Promise<unknown> {
        let failure: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await this.#storage.kv.transaction(ctx, async (kv) => {
                    const configs = kv.scoped("config");
                    const creations = kv.scoped("creating");
                    if (wroteConfig) await configs.delete(ctx, agentId);
                    const current = creationRecordOf(await creations.read(ctx, agentId));
                    if (current?.token !== token) throw STALE_ROLLBACK;
                    await creations.delete(ctx, agentId);
                });
                return failure;
            } catch (error) {
                if (error === STALE_ROLLBACK) return undefined;
                failure = error;
            }
        }
        return failure;
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
            await this.#active.delete(lockCtx, agentId);
            await this.#configs.delete(lockCtx, agentId);
            await this.#creations.delete(lockCtx, agentId);
            this.#persistences.delete(agentId);
        });
    }

    /** Erase everything one agent's store holds, in one step. */
    async #wipe(ctx: Context, agentId: string): Promise<void> {
        const persistence = this.#persistenceFor(agentId);
        await agentBaseWithStoreStill(ctx, persistence, (storeCtx) =>
            persistence.transaction(storeCtx, async (txCtx) => {
                await persistence.clearRecords(txCtx);
                for (const { key } of await persistence.readValues(txCtx, "")) {
                    await persistence.deleteValue(txCtx, key);
                }
            }),
        );
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
            if (config === undefined || (await this.#beingCreated(lockCtx, agentId))) {
                throw new Error(`Agent "${agentId}" has not been created.`);
            }
            const agent = await this.#instantiate(lockCtx, agentId, config);
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

    /** Whether a creation has claimed this identity but has not finished producing its agent. */
    async #beingCreated(ctx: Context, agentId: string): Promise<boolean> {
        return creationRecordOf(await this.#creations.read(ctx, agentId))?.pending === true;
    }

    /**
     * Build one agent and put it to work. Called with the agent's lock held, and only for an ID
     * that has no live instance yet.
     */
    async #instantiate(ctx: Context, agentId: string, config: AgentConfig): Promise<Agent> {
        const agentCtx = withAgentConfig(withAgentSystem(ctx, this.#ref), config);
        await this.#loadShared(ctx);
        const features = this.#featureClasses.map((Feature) => new Feature(agentId));
        const ownedFeatures = [...this.#sharedFeatures, ...features];
        const activity = this.#activityFeature(agentId);
        // Every load is waited for even when one of them fails: a load that is still running has
        // resources in flight, and abandoning it would let a retry of this same creation overlap
        // its own previous attempt.
        const loads = await Promise.allSettled(
            [...features, activity].map(async (feature) => feature.load?.(agentCtx)),
        );
        const failed = loads.find((load) => load.status === "rejected");
        if (failed !== undefined) throw failed.reason;
        // An identity built here may already have durable state — this is the path a restart
        // resolves through — so the agent is loaded rather than created, and knows whether it
        // has work left before anything asks it.
        const agent = await Agent.load(agentCtx, {
            id: agentId,
            providers: this.#providers,
            provider: this.#provider,
            persistence: this.#persistenceFor(agentId),
            // Shared first: the instructions they contribute — above all the system prompt —
            // open every agent's prompt, before anything one agent alone was configured with.
            features: [...ownedFeatures, activity],
        });
        agent.start();
        this.#agents.set(agentId, agent);
        return agent;
    }

    /**
     * Load the shared features once, before the first agent that needs them exists. They belong
     * to the collection rather than to any agent, so they load on the collection's own context:
     * whatever they read at load time must not come from whichever agent happened to be built
     * first. A failed load is forgotten, so the next agent tries again instead of inheriting a
     * collection that can never build one; a shared load must therefore not resolve an agent,
     * which would wait for the very load it is part of.
     */
    async #loadShared(ctx: Context): Promise<void> {
        this.#sharedLoad ??= this.#loadSharedFeatures(withAgentSystem(ctx, this.#ref)).catch(
            (error: unknown) => {
                this.#sharedLoad = undefined;
                throw error;
            },
        );
        await this.#sharedLoad;
    }

    /** Load every shared feature once, on the collection's own context. */
    async #loadSharedFeatures(sharedCtx: Context): Promise<void> {
        const loads = await Promise.allSettled(
            this.#sharedFeatures.map(async (feature) => feature.load?.(sharedCtx)),
        );
        const failed = loads.find((load) => load.status === "rejected");
        if (failed !== undefined) throw failed.reason;
    }

    /**
     * Resolve and resume every agent that has work left from before this process started.
     *
     * The active index is a fast answer, not the authority. It is written by a live run and can
     * only ever describe the moment it was read: a process that committed a message and died
     * before publishing another active span leaves an identity that owes an answer and appears
     * in no index at all. So an identity the index does not vouch for is not dismissed — its own
     * store is asked, which is where the evidence actually is.
     */
    async start(ctx: Context): Promise<void> {
        const active = (await this.#active.list(ctx))
            .filter(({ value }) => value === true)
            .map(({ key }) => key);
        const created = await this.#configs.list(ctx);
        await Promise.all(
            created.map(async ({ key: agentId }) => {
                // An identity another owner is still creating is not this process's to resume:
                // its creation may yet roll back, and until it finishes there is no agent.
                if (await this.#beingCreated(ctx, agentId)) return;
                if (!active.includes(agentId) && !(await this.#owesWork(ctx, agentId))) return;
                await this.resolve(ctx, agentId);
            }),
        );
    }

    /**
     * Whether one identity's own store has work left. The store is held still for the question,
     * so what it answers is a settled state rather than the middle of some owner's step — a
     * consumed message whose record has landed while the queue entry that carried it has not
     * would otherwise read as two different conversations depending on the instant.
     */
    async #owesWork(ctx: Context, agentId: string): Promise<boolean> {
        const persistence = this.#persistenceFor(agentId);
        return await agentBaseWithStoreStill(ctx, persistence, (storeCtx) =>
            agentBaseStoreOwesWork(storeCtx, persistence),
        );
    }

    /**
     * Durable storage for one feature, shared by every agent here and outliving all of them.
     */
    featureState(feature: string): AgentBaseKV {
        return this.#storage.kv.scoped("features", feature);
    }

    /** A collection-wide feature by its stable name. */
    feature(name: string): AgentFeature | undefined {
        return this.#sharedFeatures.find((feature) => feature.name === name);
    }

    /** The durable store for one agent, created once and reused for the life of the collection. */
    #persistenceFor(agentId: string): AgentBasePersistence {
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

    /**
     * Build the lifecycle hook that marks an agent active when its loop starts and idle once the
     * loop has finished.
     */
    #activityFeature(agentId: string): AgentFeature {
        return {
            name: "agents-activity",
            beforeAgentLoop: async (ctx) => {
                await this.#active.write(ctx, agentId, true);
            },
            afterAgentSettled: async (ctx) => {
                // One agent's store can have several live owners, and the index describes the
                // identity rather than any one of them. This owner having nothing left to do
                // does not mean the identity has: another owner may be mid-response right now,
                // and clearing the index under it would leave a working agent that the next
                // process has no reason to resume. So the store decides, not this run.
                if (await this.#owesWork(ctx, agentId)) return;
                await this.#active.delete(ctx, agentId);
                // The index holds a boolean, so there is nothing in it to tell one owner's entry
                // from another's and no way to remove only one's own. An owner that began while
                // this deletion was in flight is erased by it, and no check made beforehand can
                // see that far — so the store is asked once more afterwards and an identity that
                // turns out to owe work is put back. Nothing depends on the index being right in
                // between: a start reads every created identity's own store regardless.
                if (await this.#owesWork(ctx, agentId)) {
                    await this.#active.write(ctx, agentId, true);
                }
            },
        };
    }
}
