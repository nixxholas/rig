import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalFeature } from "../GoalFeature.js";
import { sessionGoalSchema } from "../SessionGoal.js";

/** The tool that starts a goal for one agent. */
export function createGoalTool(goals: GoalFeature, agentId: string) {
    return defineAgentTool({
        name: "create_goal",
        description: `Create a persistent goal only when the user explicitly asks for long-running goal execution.
Do not infer a goal from an ordinary task. A new goal cannot replace an unfinished goal.`,
        parameters: Type.Object(
            {
                objective: Type.String({
                    description:
                        "The concrete objective to pursue until it is complete or blocked.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ goal: sessionGoalSchema }),
        // Setting the same objective twice answers with the goal already running, so a call
        // interrupted by a restart can simply be made again.
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { objective }) => ({
            goal: await goals.setGoal(ctx, agentId, objective),
        }),
        toLLM: ({ goal }) => [
            { type: "text", text: `Goal created and active.\nObjective: ${goal.objective}` },
        ],
    });
}
