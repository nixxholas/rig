import { Type } from "@sinclair/typebox";

import {
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
    MIN_SUBAGENT_WAIT_TIMEOUT_MS,
} from "../../../context/subagentWaitTimeouts.js";
import { defineTool } from "../../../types.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";

export const codexWaitAgentTool = defineTool({
    name: "wait_agent",
    label: "wait_agent",
    namespace: {
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
    },
    description:
        "Wait for a subagent status change or completion. Returns early when an agent updates, new user input arrives, or the wait is cancelled. Omit timeout_ms so the wait lasts a full hour. A background agent that finishes notifies you anyway, even while you are idle, so repeated short waits only spend another full model turn to learn nothing.",
    arguments: Type.Object({
        timeout_ms: Type.Optional(
            Type.Number({
                description: `Maximum wait in milliseconds. Defaults to ${DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS} (one hour), which is almost always right; min ${MIN_SUBAGENT_WAIT_TIMEOUT_MS}, max ${MAX_SUBAGENT_WAIT_TIMEOUT_MS}. Never use it as a polling interval.`,
                maximum: MAX_SUBAGENT_WAIT_TIMEOUT_MS,
                minimum: MIN_SUBAGENT_WAIT_TIMEOUT_MS,
            }),
        ),
    }),
    returnType: Type.Object({
        message: Type.String(),
        timed_out: Type.Boolean(),
    }),
    interruptionMessage: "Waiting for subagents was interrupted by new input.",
    shouldReviewInAutoMode: () => false,
    steerable: true,
    execute: async ({ timeout_ms }, context, execution) => {
        const result = await requireSubagentContext(context).wait(
            timeout_ms ?? DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
            execution.signal,
        );
        return {
            message: result.timedOut
                ? "Wait timed out."
                : result.agents.length === 0
                  ? "Wait interrupted by new input."
                  : "Wait completed.",
            timed_out: result.timedOut,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.timed_out ? "No subagent updates arrived before the wait ended." : result.message,
    locks: [],
});
