import { agentKV, withAgentKV, type AgentKV } from "@slopus/happy-agent-base";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

const userInputToolKVNamespace = createContextNamespace<AgentKV | undefined>(
    "userInputToolCallKV",
    undefined,
);

/**
 * Mark a context as belonging to one durable request_user_input call.
 *
 * Public feature methods may be called with a feature-scoped AgentKV from a host hook. That KV
 * must never be mistaken for the call-scoped store used to survive a tool retry, so the tool
 * creates an explicitly narrowed context before invoking the feature.
 */
export function withUserInputToolContext(ctx: Context): Context {
    const callKV = agentKV(ctx);
    if (callKV === undefined) {
        throw new Error("User input tools require an Agent Base call-scoped store.");
    }
    const scoped = callKV.scoped("feature", "userInput");
    return userInputToolKVNamespace.set(withAgentKV(ctx, scoped), scoped);
}

/** Return the call-scoped KV only when the context was marked by request_user_input. */
export function userInputToolKV(ctx: Context): AgentKV | undefined {
    return userInputToolKVNamespace.get(ctx);
}