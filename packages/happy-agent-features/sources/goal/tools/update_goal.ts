import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { GoalFeature } from "../GoalFeature.js";
import { sessionGoalSchema } from "../SessionGoal.js";

/** The tool that ends one agent's goal. */
export function updateGoalTool(goals: GoalFeature, agentId: string) {
    return defineAgentTool({
        name: "update_goal",
        description: `Mark the persistent goal complete or blocked.
Use complete only when the full objective is achieved and verified with no required work remaining.
Use blocked only when meaningful progress cannot continue without user input or an external state change.
Pausing, resuming, and clearing a goal are controlled by the user.`,
        parameters: Type.Object(
            {
                status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
                    description: "The terminal status for the current goal.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ goal: sessionGoalSchema }),
        // Reporting the status the goal already has changes nothing, so a call interrupted by a
        // restart can simply be made again.
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { status }) => ({
            goal: await goals.changeGoalStatus(ctx, agentId, status),
        }),
        toLLM: ({ goal }) => [
            {
                type: "text",
                text:
                    goal.status === "complete"
                        ? "Goal marked complete."
                        : "Goal marked blocked. Explain the blocker and what the user needs to provide or change.",
            },
        ],
    });
}
