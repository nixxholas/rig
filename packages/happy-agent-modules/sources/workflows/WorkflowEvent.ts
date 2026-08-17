import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { workflowAgentIdSchema, workflowRunSchema, workflowTimestampSchema } from "./Workflow.js";

export const MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH = 500;

export const workflowEventIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
});

/** Bounded, value-free diagnostic passed to the advisory post-commit reporter. */
export const workflowPostCommitErrorSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH,
    pattern: "^[^\\u0000]*$",
});

/**
 * What happened to a run, for anything showing a person its progress. A workflow changes on its
 * own for as long as it runs, so the interesting moments are that it began, that it moved, and
 * that it stopped for good.
 */
export const workflowEventSchema = Type.Object(
    {
        type: Type.Union([
            Type.Literal("workflow_started"),
            Type.Literal("workflow_updated"),
            Type.Literal("workflow_finished"),
        ]),
        agentId: workflowAgentIdSchema,
        eventId: workflowEventIdSchema,
        at: workflowTimestampSchema,
        run: workflowRunSchema,
    },
    { additionalProperties: false },
);

export type WorkflowEvent = Static<typeof workflowEventSchema>;
export type WorkflowPostCommitError = Static<typeof workflowPostCommitErrorSchema>;

export const workflowModuleListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowEventSchema,
                ],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
        onEvent: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowEventSchema,
                ],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkflowModuleListener = Static<typeof workflowModuleListenerSchema>;
