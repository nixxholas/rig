import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalFeature } from "../GoalFeature.js";
import { sessionGoalSchema } from "../SessionGoal.js";

/** The tool that reads one agent's goal. */
export function getGoalTool(goals: GoalFeature, agentId: string) {
    return defineAgentTool({
        name: "get_goal",
        description: "Get the persistent goal for this agent, including its objective and status.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object({ goal: Type.Union([sessionGoalSchema, Type.Null()]) }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({ goal: (await goals.goal(ctx, agentId)) ?? null }),
        toLLM: ({ goal }) => [
            {
                type: "text",
                text:
                    goal === null
                        ? "This agent has no goal."
                        : `Goal status: ${goal.status}\nObjective: ${goal.objective}`,
            },
        ],
    });
}
