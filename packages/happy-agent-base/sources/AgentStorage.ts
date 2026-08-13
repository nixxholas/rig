import type { AgentKV } from "./AgentKV.js";
import type { AgentPersistence } from "./AgentPersistence.js";

/** What an `AgentStorage` is built from. */
export interface AgentStorageOptions {
    /** Shared key-value storage used for state spanning all agents. */
    readonly kv: AgentKV;
    /** Produce the isolated persistence used by one agent. */
    readonly persistence: (agentId: string) => AgentPersistence;
}

/** Storage roots shared by an `AgentSystemLocal` collection. */
export class AgentStorage {
    /** Shared key-value storage used for state spanning all agents. */
    readonly kv: AgentKV;
    /** Produces the isolated persistence used by one agent. */
    readonly #persistence: (agentId: string) => AgentPersistence;

    constructor(options: AgentStorageOptions) {
        this.kv = options.kv;
        this.#persistence = options.persistence;
    }

    /** The isolated persistence for the given agent. */
    persistence(agentId: string): AgentPersistence {
        return this.#persistence(agentId);
    }
}
