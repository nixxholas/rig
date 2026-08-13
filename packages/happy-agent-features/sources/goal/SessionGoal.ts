import { Type, type Static } from "@sinclair/typebox";

/**
 * Where a goal stands. Only `complete` and `blocked` are the model's to choose: it declares the
 * objective met, or says it cannot get any further alone. `paused` belongs to the person, who
 * may stop a goal running without abandoning it, and `active` is what a goal is created as and
 * returns to when they resume it.
 */
export const goalStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("paused"),
    Type.Literal("blocked"),
    Type.Literal("complete"),
]);

/** One agent's goal, exactly as it is stored. */
export const sessionGoalSchema = Type.Object(
    {
        createdAt: Type.Number(),
        objective: Type.String(),
        status: goalStatusSchema,
        updatedAt: Type.Number(),
    },
    { additionalProperties: false },
);

export type GoalStatus = Static<typeof goalStatusSchema>;
export type SessionGoal = Static<typeof sessionGoalSchema>;
