import { AgentKV, type AgentStorage } from "@slopus/happy-agent-base";

/**
 * The goal feature's own store for one agent, addressed from the collection's storage rather
 * than from a running hook.
 *
 * A feature is also called from outside the agent system — by an API setting a goal on an agent
 * that is not running, and may never have run — so it cannot wait to be handed a scope. It
 * addresses the same store the agent lends its features: the agent's key-value space, narrowed
 * to this feature's name. The two must stay identical, and the test that sets a goal through
 * the tools and reads it back through the feature is what keeps them so.
 */
export function goalKV(storage: AgentStorage, agentId: string): AgentKV {
    return new AgentKV(storage.persistence(agentId), `kv.${agentId}.`).scoped("feature", "goal");
}
