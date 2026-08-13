import type { SessionMessage } from "@slopus/happy-providers";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

/** Backing storage for `agentTaskContext`: the parent conversation before a tool call. */
const taskContextNamespace = createContextNamespace<readonly SessionMessage[] | undefined>(
    "happyAgent.taskContext",
    undefined,
);

/**
 * Carry the parent conversation that existed before the assistant response containing the
 * current tool call. The snapshot is immutable caller context: collaboration can fork it without
 * gaining a general-purpose history-reading capability.
 */
export function withAgentTaskContext(ctx: Context, messages: readonly SessionMessage[]): Context {
    return taskContextNamespace.set(ctx, structuredClone(messages));
}

/** The pre-tool-call parent conversation available to the current tool execution. */
export function agentTaskContext(ctx: Context): readonly SessionMessage[] {
    return structuredClone(taskContextNamespace.get(ctx) ?? []);
}

/**
 * Select everything before the assistant response that issued `callId`. Removing the complete
 * response follows Codex's fork boundary and prevents sibling calls, reasoning, or prefatory
 * assistant text from leaking into a child while that response is still being settled.
 */
export function taskContextBeforeToolCall(
    messages: readonly SessionMessage[],
    callId: string,
): readonly SessionMessage[] {
    const boundary = messages.findIndex(
        (message) =>
            message.role === "assistant" &&
            message.content.some((block) => block.type === "tool_call" && block.callId === callId),
    );
    return structuredClone(boundary < 0 ? messages : messages.slice(0, boundary));
}
