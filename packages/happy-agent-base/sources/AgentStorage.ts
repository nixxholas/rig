import type { AgentBaseKV } from "./AgentBaseKV.js";
import type { AgentBasePersistence } from "./AgentBasePersistence.js";

export interface AgentStorageOptions {
    /** Shared key-value storage used for state spanning all agents. */
    readonly kv: AgentBaseKV;
    /** Produce the isolated persistence used by one agent. */
    readonly persistence: (agentId: string) => AgentBasePersistence;
}

/** Storage roots shared by an `AgentSystemLocal` collection. */
export class AgentStorage {
    readonly kv: AgentBaseKV;
    readonly #persistence: (agentId: string) => AgentBasePersistence;

    constructor(options: AgentStorageOptions) {
        this.kv = options.kv;
        this.#persistence = options.persistence;
    }

    persistence(agentId: string): AgentBasePersistence {
        return this.#persistence(agentId);
    }
}
