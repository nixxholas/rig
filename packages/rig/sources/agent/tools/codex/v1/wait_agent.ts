import { Type } from "@sinclair/typebox";

import {
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
    MIN_SUBAGENT_WAIT_TIMEOUT_MS,
} from "../../../context/subagentWaitTimeouts.js";
import { defineTool } from "../../../types.js";
import { codexAgentStatusSchema } from "../impl/codexAgentStatusSchema.js";
import { requireSubagentContext } from "../impl/requireSubagentContext.js";
import { toCodexAgentStatus } from "../impl/toCodexAgentStatus.js";

export const codexV1WaitAgentTool = defineTool({
    name: "wait_agent",
    label: "wait_agent",
    namespace: {
        name: "multi_agent_v1",
        description: "Tools for spawning and managing sub-agents.",
    },
    description:
        "Wait for any selected agent to reach a final status. Omit timeout_ms so the wait lasts a full hour. A background agent that finishes notifies you anyway, even while you are idle, so repeated short waits only spend another full model turn to learn nothing.",
    arguments: Type.Object(
        {
            targets: Type.Array(Type.String(), {
                description: "Stable Agent IDs (preferred) or canonical task paths to wait on.",
            }),
            timeout_ms: Type.Optional(
                Type.Number({
                    description: `Timeout in milliseconds. Defaults to ${DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS} (one hour), which is almost always right; min ${MIN_SUBAGENT_WAIT_TIMEOUT_MS}, max ${MAX_SUBAGENT_WAIT_TIMEOUT_MS}. Never use it as a polling interval.`,
                    minimum: MIN_SUBAGENT_WAIT_TIMEOUT_MS,
                    maximum: MAX_SUBAGENT_WAIT_TIMEOUT_MS,
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agents: Type.Array(
            Type.Object({
                agent_id: Type.String(),
                path: Type.String(),
                status: codexAgentStatusSchema,
            }),
        ),
        status: Type.Record(Type.String(), codexAgentStatusSchema),
        timed_out: Type.Boolean(),
    }),
    shouldReviewInAutoMode: () => false,
    execute: async ({ targets, timeout_ms }, context, execution) => {
        const subagents = requireSubagentContext(context);
        const targetSet = new Set(targets);
        const timeout = timeout_ms ?? DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS;
        const deadline = Date.now() + timeout;
        while (true) {
            const remaining = Math.max(0, deadline - Date.now());
            const result = await subagents.wait(remaining, execution.signal);
            const agents = result.agents.filter(
                (agent) => targetSet.has(agent.agentId) || targetSet.has(agent.path),
            );
            if (agents.length > 0) {
                return {
                    agents: agents.map((agent) => ({
                        agent_id: agent.agentId,
                        path: agent.path,
                        status: toCodexAgentStatus(agent),
                    })),
                    status: Object.fromEntries(
                        agents.map((agent) => [agent.agentId, toCodexAgentStatus(agent)]),
                    ),
                    timed_out: false,
                };
            }
            if (result.timedOut || remaining === 0) {
                return {
                    agents: [] as {
                        agent_id: string;
                        path: string;
                        status: ReturnType<typeof toCodexAgentStatus>;
                    }[],
                    status: {},
                    timed_out: true,
                };
            }
        }
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.timed_out
            ? "No selected subagent completed before the wait ended."
            : "Selected subagent status changed.",
    locks: [],
    steerable: true,
});
