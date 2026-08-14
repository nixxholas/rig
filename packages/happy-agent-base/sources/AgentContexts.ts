import type { SessionReasoningEffort, SessionServiceTier } from "@slopus/happy-providers";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import type { AgentKV } from "./AgentKV.js";
import { DEFAULT_AGENT_PERMISSION_MODE, type AgentPermissionMode } from "./AgentPermissionMode.js";

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
/** Backing storage for `agentPermissionMode`: how much the work on a context may touch. */
const permissionModeNamespace = createContextNamespace<AgentPermissionMode>(
    "agentPermissionMode",
    DEFAULT_AGENT_PERMISSION_MODE,
);
/** Backing storage for `agentKV`: the scoped key-value store carried on a context. */
const kvNamespace = createContextNamespace<AgentKV | undefined>("agentKV", undefined);
/** Backing storage for `agentRunKV`: the run's own store, erased when the agent settles. */
const runKVNamespace = createContextNamespace<AgentKV | undefined>("agentRunKV", undefined);

/**
 * Derive the agent's context carrying its ID, provider ID, model, effort, service tier, and
 * permission mode — all serializable values. The agent applies this once at construction, so hooks
 * and tool executions can read the values back through the accessors below. The ID is what lets one
 * feature instance serve every agent in a collection: a shared feature learns which agent a hook is
 * running for from the context rather than from something it was constructed with.
 */
export function withAgentContext(
    ctx: Context,
    values: {
        readonly id: string;
        readonly provider: string;
        readonly model?: string | undefined;
        readonly effort?: SessionReasoningEffort | undefined;
        readonly serviceTier?: SessionServiceTier | undefined;
        readonly permissionMode: AgentPermissionMode;
    },
): Context {
    const withId = idNamespace.set(ctx, values.id);
    const withProvider = providerNamespace.set(withId, values.provider);
    const withModel = modelNamespace.set(withProvider, values.model);
    const withEffort = effortNamespace.set(withModel, values.effort);
    const withTier = serviceTierNamespace.set(withEffort, values.serviceTier);
    return permissionModeNamespace.set(withTier, values.permissionMode);
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

/**
 * How much the work on this context may touch. It is the mode the agent is running in, unless a
 * narrower scope replaced it for one execution.
 */
export function agentPermissionMode(ctx: Context): AgentPermissionMode {
    return permissionModeNamespace.get(ctx);
}

/**
 * Run one stretch of work under another mode. This is how an allowed Auto action is lent the access
 * it was reviewed for: the work derived from this context sees the wider mode, and everything
 * outside it goes on seeing the agent's own. Deriving from a context the agent handed out is what
 * keeps the rest of that context — the agent's identity, its stores, its lifetime — intact.
 */
export function withAgentPermissionMode(ctx: Context, mode: AgentPermissionMode): Context {
    return permissionModeNamespace.set(ctx, mode);
}

/** Carry a scoped key-value store on the context, replacing any store carried before. */
export function withAgentKV(ctx: Context, kv: AgentKV): Context {
    return kvNamespace.set(ctx, kv);
}

/** The scoped key-value store carried on this context, when the agent attached one. */
export function agentKV(ctx: Context): AgentKV | undefined {
    return kvNamespace.get(ctx);
}

/**
 * Carry the store belonging to the run in progress, replacing any run store carried before. What
 * it holds lives exactly as long as the work does: the agent erases the whole scope in the
 * transaction that settles it, so nothing written here outlives the run that wrote it.
 */
export function withAgentRunKV(ctx: Context, kv: AgentKV): Context {
    return runKVNamespace.set(ctx, kv);
}

/** The run's own store carried on this context, when the agent attached one. */
export function agentRunKV(ctx: Context): AgentKV | undefined {
    return runKVNamespace.get(ctx);
}
