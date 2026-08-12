import type { SessionReasoningEffort, SessionServiceTier } from "@slopus/happy-providers";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

const modelNamespace = createContextNamespace<string | undefined>(
    "agentBaseModel",
    undefined,
);
const effortNamespace = createContextNamespace<SessionReasoningEffort | undefined>(
    "agentBaseEffort",
    undefined,
);
const providerNamespace = createContextNamespace<string | undefined>(
    "agentBaseProvider",
    undefined,
);
const serviceTierNamespace = createContextNamespace<SessionServiceTier | undefined>(
    "agentBaseServiceTier",
    undefined,
);

/**
 * Derive the agent's context carrying its provider ID, model, effort, and service tier — all serializable
 * values. The agent applies this once at construction, so hooks and tool executions can read
 * the values back through the accessors below.
 */
export function withAgentBaseContext(
    ctx: Context,
    values: {
        readonly provider: string;
        readonly model?: string | undefined;
        readonly effort?: SessionReasoningEffort | undefined;
        readonly serviceTier?: SessionServiceTier | undefined;
    },
): Context {
    const withProvider = providerNamespace.set(ctx, values.provider);
    const withModel = modelNamespace.set(withProvider, values.model);
    const withEffort = effortNamespace.set(withModel, values.effort);
    return serviceTierNamespace.set(withEffort, values.serviceTier);
}

/** The model configured for the agent owning this context, when one was set. */
export function agentBaseModel(ctx: Context): string | undefined {
    return modelNamespace.get(ctx);
}

/** The reasoning effort configured for the agent owning this context, when one was set. */
export function agentBaseEffort(ctx: Context): SessionReasoningEffort | undefined {
    return effortNamespace.get(ctx);
}

/** The registry ID of the provider of the agent owning this context. */
export function agentBaseProvider(ctx: Context): string | undefined {
    return providerNamespace.get(ctx);
}

/** The service tier configured for the agent owning this context, when one was set. */
export function agentBaseServiceTier(ctx: Context): SessionServiceTier | undefined {
    return serviceTierNamespace.get(ctx);
}
