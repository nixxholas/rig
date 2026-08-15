import { AgentKV, AgentStorage } from "@slopus/happy-agent-base";

import { InMemoryPersistence } from "./InMemoryPersistence.js";

/** One collection's storage, with each agent's store kept so a test can look inside it. */
export interface AgentWorld {
    readonly storage: AgentStorage;
    readonly stores: Map<string, InMemoryPersistence>;
}

/** Storage standing in for a collection's, giving every agent its own isolated store. */
export function agentWorld(): AgentWorld {
    const stores = new Map<string, InMemoryPersistence>();
    let locked = false;
    const storage = new AgentStorage({
        acquireLock: () => {
            if (locked) return Promise.reject(new Error("The agent store is already locked."));
            locked = true;
            return Promise.resolve({
                release: () => {
                    locked = false;
                    return Promise.resolve();
                },
            });
        },
        kv: new AgentKV(new InMemoryPersistence(), "shared."),
        persistence: (agentId) => {
            const existing = stores.get(agentId);
            if (existing !== undefined) return existing;
            const created = new InMemoryPersistence();
            stores.set(agentId, created);
            return created;
        },
    });
    return { storage, stores };
}
