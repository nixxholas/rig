import type { SessionUserMessage } from "@slopus/happy-providers";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { Agent } from "./Agent.js";
import {
    agentBaseOwesWork,
    type AgentBaseAwaitOptions,
    type AgentBaseMessageOptions,
} from "./AgentBase.js";
import type { AgentBaseKV } from "./AgentBaseKV.js";
import type { AgentBasePersistence } from "./AgentBasePersistence.js";
import { agentBaseWithStoreStill } from "./AgentBaseStoreLock.js";
import { agentConfigSchema, withAgentConfig, type AgentConfig } from "./AgentConfig.js";
import type { AgentFeature, AgentFeatureConstructor } from "./AgentFeature.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AgentStorage } from "./AgentStorage.js";
import type { AgentSystem } from "./AgentSystem.js";
import { withAgentSystem } from "./AgentSystemContext.js";

export interface AgentSystemLocalOptions {
    readonly features: readonly AgentFeatureConstructor[];
    readonly storage: AgentStorage;
    readonly providers: AgentProviders;
    readonly provider: string;
    readonly models: readonly AgentModel[];
}

/** The record that says an identity exists, and which creation it belongs to. */
interface CreationRecord {
    readonly token: string;
    readonly pending?: boolean;
}

/** Thrown inside a rollback that found the identity already belonged to someone else. */
const STALE_ROLLBACK = Symbol("staleRollback");

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
    readonly models: readonly AgentModel[];

    readonly #featureClasses: readonly AgentFeatureConstructor[];
    readonly #storage: AgentStorage;
    readonly #providers: AgentProviders;
    readonly #provider: string;
    readonly #active: AgentBaseKV;
    readonly #configs: AgentBaseKV;
    /** Which creation an identity belongs to, and whether that creation has finished. */
    readonly #creations: AgentBaseKV;
    readonly #agents = new Map<string, Agent>();
    // One agent has one store for the life of the collection, so inspecting an agent's durable
    // work and running that agent never end up looking at two different stores.
    readonly #persistences = new Map<string, AgentBasePersistence>();
    readonly #locks = new Map<string, AsyncLock>();

    constructor(options: AgentSystemLocalOptions) {
        this.#featureClasses = options.features;
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
    async create(ctx: Context, agentId: string, config: AgentConfig): Promise<Agent> {
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

    /** The configuration an agent was created with, or undefined when there is no such agent. */
    async config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        const stored = await this.#configs.read(ctx, agentId);
        if (stored === undefined) return undefined;
        if (!Value.Check(agentConfigSchema, stored)) {
            throw new Error(`The stored configuration of agent "${agentId}" is not valid.`);
        }
        return stored;
    }

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
        const agentCtx = withAgentConfig(withAgentSystem(ctx, this), config);
        const features = this.#featureClasses.map((Feature) => new Feature(agentId));
        const activity = this.#activityFeature(agentId);
        // Every load is waited for even when one of them fails: a load that is still running has
        // resources in flight, and abandoning it would let a retry of this same creation overlap
        // its own previous attempt.
        const loads = await Promise.allSettled(
            [...features, activity].map(async (feature) => feature.load?.(agentCtx)),
        );
        const failed = loads.find((load) => load.status === "rejected");
        if (failed !== undefined) throw failed.reason;
        const agent = new Agent(agentCtx, {
            id: agentId,
            providers: this.#providers,
            provider: this.#provider,
            persistence: this.#persistenceFor(agentId),
            features: [...features, activity],
        });
        agent.start();
        this.#agents.set(agentId, agent);
        return agent;
    }

    /** Resolve and resume every agent that has work left from before this process started. */
    async start(ctx: Context): Promise<void> {
        const active = new Set(
            (await this.#active.list(ctx))
                .filter(({ value }) => value === true)
                .map(({ key }) => key),
        );
        const created = await this.#configs.list(ctx);
        await Promise.all(
            created.map(async ({ key: agentId }) => {
                // An identity another owner is still creating is not this process's to resume:
                // its creation may yet roll back, and until it finishes there is no agent.
                if (await this.#beingCreated(ctx, agentId)) return;
                // The activity index alone cannot answer this: a message accepted while an
                // agent was settling is durable before the settle's index deletion commits, and
                // the agent that owes the answer would otherwise be invisible to this process.
                const owed = await agentBaseOwesWork(ctx, this.#persistenceFor(agentId));
                if (!active.has(agentId) && !owed) return;
                await this.resolve(ctx, agentId);
            }),
        );
    }

    /**
     * Durable storage for one feature, shared by every agent here and outliving all of them.
     */
    featureState(feature: string): AgentBaseKV {
        return this.#storage.kv.scoped("features", feature);
    }

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

    async steer(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        const agent = await this.resolve(ctx, agentId);
        await agent.steer(ctx, message, options);
        await this.#publish(ctx, agentId);
    }

    async send(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        const agent = await this.resolve(ctx, agentId);
        await agent.send(ctx, message, options);
        await this.#publish(ctx, agentId);
    }

    /**
     * Make an agent discoverable before its caller is told the message was accepted. Acceptance
     * means durable and findable: a process lost the moment a send resolves must still have a
     * way to reach the agent that owes the answer.
     */
    async #publish(ctx: Context, agentId: string): Promise<void> {
        await this.#active.write(ctx, agentId, true);
    }

    async abort(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void> {
        await (await this.resolve(ctx, agentId)).abort(ctx, options);
    }

    async compact(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void> {
        await (await this.resolve(ctx, agentId)).compact(ctx, options);
    }

    #activityFeature(agentId: string): AgentFeature {
        return {
            name: "agents-activity",
            beforeAgentLoop: async (ctx) => {
                await this.#active.write(ctx, agentId, true);
            },
            afterAgentSettled: async (ctx) => {
                // The index says an agent is worth resuming, and this agent settling says only
                // that this agent has nothing left to do. Another owner over the same store may
                // owe work — including work accepted while this deletion was in flight — so the
                // store is asked again afterwards, and an entry that turned out to still be
                // needed is put back rather than left missing.
                const persistence = this.#persistenceFor(agentId);
                if (await agentBaseOwesWork(ctx, persistence)) return;
                await this.#active.delete(ctx, agentId);
                if (await agentBaseOwesWork(ctx, persistence)) {
                    await this.#active.write(ctx, agentId, true);
                }
            },
        };
    }
}
