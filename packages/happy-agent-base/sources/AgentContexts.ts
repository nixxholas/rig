import type { SessionReasoningEffort, SessionServiceTier } from "@slopus/happy-providers";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import type { AgentBaseKV } from "./AgentBaseKV.js";

/** Backing storage for `agentId`: the ID of the agent owning a context. */
const idNamespace = createContextNamespace<string | undefined>("agentId", undefined);
/** Backing storage for `agentModel`: the model configured for the agent, when one was set. */
const modelNamespace = createContextNamespace<string | undefined>("agentModel", undefined);
/** Backing storage for `agentEffort`: the reasoning effort configured, when one was set. */
const effortNamespace = createContextNamespace<SessionReasoningEffort | undefined>(
    "agentEffort",
    undefined,
);
/** Backing storage for `agentProvider`: the registry ID of the provider owning a context. */
const providerNamespace = createContextNamespace<string | undefined>("agentProvider", undefined);
/** Backing storage for `agentServiceTier`: the service tier configured, when one was set. */
const serviceTierNamespace = createContextNamespace<SessionServiceTier | undefined>(
    "agentServiceTier",
    undefined,
);
/** Backing storage for `agentKV`: the scoped key-value store carried on a context. */
const kvNamespace = createContextNamespace<AgentBaseKV | undefined>("agentKV", undefined);

/**
 * Derive the agent's context carrying its ID, provider ID, model, effort, and service tier — all
 * serializable values. The agent applies this once at construction, so hooks and tool executions
 * can read the values back through the accessors below. The ID is what lets one feature instance
 * serve every agent in a collection: a shared feature learns which agent a hook is running for
 * from the context rather than from something it was constructed with.
 */
export function withAgentContext(
    ctx: Context,
    values: {
        readonly id: string;
        readonly provider: string;
        readonly model?: string | undefined;
        readonly effort?: SessionReasoningEffort | undefined;
        readonly serviceTier?: SessionServiceTier | undefined;
    },
): Context {
    const withId = idNamespace.set(ctx, values.id);
    const withProvider = providerNamespace.set(withId, values.provider);
    const withModel = modelNamespace.set(withProvider, values.model);
    const withEffort = effortNamespace.set(withModel, values.effort);
    return serviceTierNamespace.set(withEffort, values.serviceTier);
}

/** The ID of the agent owning this context. */
export function agentId(ctx: Context): string | undefined {
    return idNamespace.get(ctx);
}

/** The model configured for the agent owning this context, when one was set. */
export function agentModel(ctx: Context): string | undefined {
    return modelNamespace.get(ctx);
}

/** The reasoning effort configured for the agent owning this context, when one was set. */
export function agentEffort(ctx: Context): SessionReasoningEffort | undefined {
    return effortNamespace.get(ctx);
}

/** The registry ID of the provider of the agent owning this context. */
export function agentProvider(ctx: Context): string | undefined {
    return providerNamespace.get(ctx);
}

/** The service tier configured for the agent owning this context, when one was set. */
export function agentServiceTier(ctx: Context): SessionServiceTier | undefined {
    return serviceTierNamespace.get(ctx);
}

/** Carry a scoped key-value store on the context, replacing any store carried before. */
export function withAgentKV(ctx: Context, kv: AgentBaseKV): Context {
    return kvNamespace.set(ctx, kv);
}

/** The scoped key-value store carried on this context, when the agent attached one. */
export function agentKV(ctx: Context): AgentBaseKV | undefined {
    return kvNamespace.get(ctx);
}
