import type { Context } from "@steve.kite/stdlib";

import type { AgentKV } from "./AgentKV.js";
import type { AgentPersistence } from "./AgentPersistence.js";

/**
 * The exclusive ownership of one durable agent store. The storage adapter must back this with
 * the database's hard process-level lock rather than an in-memory convention.
 */
export interface AgentStorageLock {
    /** Release the hard lock after the owning AgentSystem has stopped every agent. */
    release(ctx: Context): Promise<void>;
}

/** What an `AgentStorage` is built from. */
export interface AgentStorageOptions {
    /**
     * Acquire exclusive ownership of the whole store. This must fail while any other process or
     * AgentSystem owns the same durable store.
     */
    readonly acquireLock: (ctx: Context) => Promise<AgentStorageLock>;
    /** Shared key-value storage used for state spanning all agents. */
    readonly kv: AgentKV;
    /** Produce the isolated persistence used by one agent. */
    readonly persistence: (agentId: string) => AgentPersistence;
}

/** Storage roots shared by an `AgentSystemLocal` collection. */
export class AgentStorage {
    /** Shared key-value storage used for state spanning all agents. */
    readonly kv: AgentKV;
    /** Acquires the database-backed exclusive lock for this store. */
    readonly #acquireLock: (ctx: Context) => Promise<AgentStorageLock>;
    /** Produces the isolated persistence used by one agent. */
    readonly #persistence: (agentId: string) => AgentPersistence;
    /** Prevents two systems from sharing even one AgentStorage instance. */
    #owned = false;

    constructor(options: AgentStorageOptions) {
        this.kv = options.kv;
        this.#acquireLock = options.acquireLock;
        this.#persistence = options.persistence;
    }

    /**
     * Acquire exclusive ownership until the returned lock is released. The adapter's lock
     * enforces this across processes; the local guard also rejects accidental reuse of this
     * object.
     */
    async acquireLock(ctx: Context): Promise<AgentStorageLock> {
        if (this.#owned) throw new Error("The agent store is already owned by another system.");
        this.#owned = true;
        let lock: AgentStorageLock;
        try {
            lock = await this.#acquireLock(ctx);
        } catch (error: unknown) {
            this.#owned = false;
            throw error;
        }
        let released = false;
        return {
            release: async (releaseCtx) => {
                if (released) return;
                await lock.release(releaseCtx);
                released = true;
                this.#owned = false;
            },
        };
    }

    /** The isolated persistence for the given agent. */
    persistence(agentId: string): AgentPersistence {
        return this.#persistence(agentId);
    }
}
