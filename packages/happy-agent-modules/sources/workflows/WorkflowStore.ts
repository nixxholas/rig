import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    workflowAgentIdSchema,
    workflowIdSchema,
    workflowLaunchRequestSchema,
    workflowLogPageSchema,
    workflowLogQuerySchema,
    workflowMutationRequestSchema,
    workflowMutationResultSchema,
    workflowPageQuerySchema,
    workflowPageSchema,
    workflowRunSchema,
    type WorkflowLogPage,
    type WorkflowMutationResult,
    type WorkflowPage,
    type WorkflowRun,
} from "./Workflow.js";

/** External runner capability. Durable run state is owned by WorkflowsModule. */
export const workflowRuntimeSchema = Type.Object(
    {
        launch: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowLaunchRequestSchema,
            ],
            Type.Promise(workflowRunSchema),
        ),
        cancel: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationRequestSchema,
            ],
            Type.Promise(workflowMutationResultSchema),
        ),
        resume: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationRequestSchema,
            ],
            Type.Promise(workflowMutationResultSchema),
        ),
        wait: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowIdSchema,
            ],
            Type.Promise(workflowRunSchema),
        ),
    },
    { additionalProperties: false },
);

/** Module-owned workflow database surface plus the external runner capability. */
export const workflowStoreSchema = Type.Object(
    {
        launch: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowLaunchRequestSchema,
            ],
            Type.Promise(workflowRunSchema),
        ),
        get: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowIdSchema,
            ],
            Type.Promise(Type.Union([workflowRunSchema, Type.Undefined()])),
        ),
        list: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowPageQuerySchema,
            ],
            Type.Promise(workflowPageSchema),
        ),
        cancel: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationRequestSchema,
            ],
            Type.Promise(workflowMutationResultSchema),
        ),
        resume: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationRequestSchema,
            ],
            Type.Promise(workflowMutationResultSchema),
        ),
        wait: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowIdSchema,
            ],
            Type.Promise(workflowRunSchema),
        ),
        save: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowRunSchema,
            ],
            Type.Promise(Type.Void()),
        ),
        logs: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowLogQuerySchema,
            ],
            Type.Promise(workflowLogPageSchema),
        ),
    },
    { additionalProperties: false },
);

export type WorkflowStore = Static<typeof workflowStoreSchema>;
export type WorkflowRuntime = Static<typeof workflowRuntimeSchema>;

export function assertWorkflowRun(value: unknown): asserts value is WorkflowRun {
    if (!Value.Check(workflowRunSchema, value)) {
        throw new Error("Workflow store returned an invalid run.");
    }
    if (value.updatedAt < value.createdAt) {
        throw new Error("Workflow store returned a run with invalid timestamp ordering.");
    }
    if ("startedAt" in value && value.startedAt !== undefined) {
        if (value.startedAt < value.createdAt || value.startedAt > value.updatedAt) {
            throw new Error("Workflow store returned a run with invalid start time.");
        }
    }
    if (value.status === "paused" && value.pausedAt !== value.updatedAt) {
        throw new Error("Workflow store returned a paused run with invalid pause time.");
    }
    if (
        (value.status === "completed" ||
            value.status === "failed" ||
            value.status === "cancelled" ||
            value.status === "unavailable") &&
        value.finishedAt !== value.updatedAt
    ) {
        throw new Error("Workflow store returned a terminal run with invalid finish time.");
    }
}

export function assertWorkflowPage(value: unknown): asserts value is WorkflowPage {
    if (!Value.Check(workflowPageSchema, value)) {
        throw new Error("Workflow store returned an invalid page.");
    }
    for (const run of value.runs) assertWorkflowRun(run);
}

export function assertWorkflowLogPage(value: unknown): asserts value is WorkflowLogPage {
    if (!Value.Check(workflowLogPageSchema, value)) {
        throw new Error("Workflow store returned an invalid log page.");
    }
}

export function assertWorkflowMutationResult(
    value: unknown,
): asserts value is WorkflowMutationResult {
    if (!Value.Check(workflowMutationResultSchema, value)) {
        throw new Error("Workflow store returned an invalid mutation result.");
    }
    assertWorkflowRun(value.run);
}
