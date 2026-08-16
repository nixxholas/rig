import { Type, type Static } from "@sinclair/typebox";

import { goalAgentIdSchema, goalInterruptionReasonSchema, goalTitleSchema } from "./SessionGoal.js";
import { goalContextSchema, goalVoidOrPromiseVoidSchema } from "./GoalEvent.js";

/**
 * The host owns work outside Goal's durable state: agent identity, session metadata, and the
 * running agent's process and queue lifecycle. Goal only asks for these narrow capabilities.
 */
export const goalHostSchema = Type.Object(
    {
        /**
         * Return whether an agent is the primary session. When omitted, Goal preserves the
         * collection-wide behavior and allows every agent to manage a goal.
         */
        isPrimaryAgent: Type.Optional(
            Type.Function(
                [goalContextSchema, goalAgentIdSchema],
                Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
            ),
        ),
        /**
         * Set the session title derived from a newly-created goal. The host decides whether its
         * title is still idle and therefore eligible for this update.
         */
        setSessionTitle: Type.Optional(
            Type.Function(
                [goalContextSchema, goalAgentIdSchema, goalTitleSchema],
                goalVoidOrPromiseVoidSchema,
            ),
        ),
        /**
         * Stop or pause work that the host owns after the goal transition commits. The host
         * implementation is responsible for aborting the active run, killing runtime processes,
         * discarding queued goal continuations, and applying descendant policy.
         */
        interruptGoalWork: Type.Optional(
            Type.Function(
                [goalContextSchema, goalAgentIdSchema, goalInterruptionReasonSchema],
                goalVoidOrPromiseVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export type GoalHost = Static<typeof goalHostSchema>;
