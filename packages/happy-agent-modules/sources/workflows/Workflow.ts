import { Type, type Static, type TSchema } from "@sinclair/typebox";

/*
 * Run identities are shown verbatim to the model. Keep their individual bounds small enough
 * that the minimum model-output budget can still contain one complete `id + workflow` row and
 * its pagination marker. The host may choose a larger output budget, but no caller should have
 * to trade away the identity needed to use the follow-up status/log tools.
 */
export const MAX_WORKFLOW_ID_LENGTH = 96;
export const MAX_WORKFLOW_AGENT_ID_LENGTH = 256;
export const MAX_WORKFLOW_NAME_LENGTH = 96;
export const MAX_WORKFLOW_INPUT_LENGTH = 20_000;
export const MAX_WORKFLOW_SCRIPT_LENGTH = 524_288;
export const MAX_WORKFLOW_SCRIPT_PATH_LENGTH = 4_096;
export const MAX_WORKFLOW_DESCRIPTION_LENGTH = 1_000;
export const MAX_WORKFLOW_ARGS_DEPTH = 8;
export const MAX_WORKFLOW_ARGS_ITEMS = 64;
export const MAX_WORKFLOW_ARGS_PROPERTIES = 64;
export const MAX_WORKFLOW_ARGS_KEY_LENGTH = 128;
export const MAX_WORKFLOW_ARGS_STRING_LENGTH = 2_000;
export const MAX_WORKFLOW_ARGS_BYTES = 65_536;
export const MAX_WORKFLOW_AGENT_COUNT = 1_000;
export const MAX_WORKFLOW_ERROR_LENGTH = 4_000;
export const MAX_WORKFLOW_PAGE_SIZE = 100;
export const MAX_WORKFLOW_LOG_LINES = 500;
export const MAX_WORKFLOW_LOG_LINE_LENGTH = 4_000;
export const MAX_WORKFLOW_OUTPUT_CHARACTERS = 20_000;
export const MAX_WORKFLOW_CURSOR = Number.MAX_SAFE_INTEGER;

export const workflowIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/** The stable owner identity every workflow read and mutation is scoped to. */
export const workflowAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_AGENT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const workflowNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_NAME_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const workflowInputSchema = Type.String({
    maxLength: MAX_WORKFLOW_INPUT_LENGTH,
});

/** A saved Python workflow source. The host runtime is responsible for reading and executing it. */
export const workflowScriptSchema = Type.String({
    maxLength: MAX_WORKFLOW_SCRIPT_LENGTH,
});

/** A host-resolved path to a saved Python workflow source. */
export const workflowScriptPathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_SCRIPT_PATH_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const workflowDescriptionSchema = Type.String({
    maxLength: MAX_WORKFLOW_DESCRIPTION_LENGTH,
});

const workflowArgsLeafSchema = Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number({
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    Type.String({ maxLength: MAX_WORKFLOW_ARGS_STRING_LENGTH }),
]);

/*
 * Keep the recursive argument contract finite. Per-level item and property limits do not bound
 * an arbitrarily deep JSON tree, so the schema itself stops at a fixed depth.
 */
function workflowArgsAtDepth(depth: number): TSchema {
    if (depth <= 0) return workflowArgsLeafSchema;
    const child = workflowArgsAtDepth(depth - 1);
    return Type.Union([
        workflowArgsLeafSchema,
        Type.Array(child, { maxItems: MAX_WORKFLOW_ARGS_ITEMS }),
        Type.Record(Type.String({ maxLength: MAX_WORKFLOW_ARGS_KEY_LENGTH }), child, {
            maxProperties: MAX_WORKFLOW_ARGS_PROPERTIES,
        }),
    ]);
}

/** JSON input exposed to a workflow script as its `args` global. */
export const workflowArgsSchema = workflowArgsAtDepth(MAX_WORKFLOW_ARGS_DEPTH);

export const workflowAgentCountSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKFLOW_AGENT_COUNT,
});

/** One accumulated progress line returned with a workflow status or wait result. */
export const workflowAccumulatedLogSchema = Type.String({
    maxLength: MAX_WORKFLOW_LOG_LINE_LENGTH,
});

export const workflowStatusSchema = Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("unavailable"),
]);

/** Legacy status vocabulary retained as an explicit compatibility projection. */
export const workflowLegacyStatusSchema = Type.Union([
    Type.Literal("completed"),
    Type.Literal("error"),
    Type.Literal("running"),
    Type.Literal("stopped"),
]);

export type WorkflowLegacyStatus = Static<typeof workflowLegacyStatusSchema>;

export const workflowTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

const workflowRunFields = {
    id: workflowIdSchema,
    agentId: workflowAgentIdSchema,
    workflow: workflowNameSchema,
    input: Type.Optional(workflowInputSchema),
    createdAt: workflowTimestampSchema,
    updatedAt: workflowTimestampSchema,
    /**
     * Runtime adapters from the first module release may omit these fields. WorkflowsModule
     * normalizes omitted values to bounded empty observations before returning them to callers.
     */
    agentCount: Type.Optional(workflowAgentCountSchema),
    logs: Type.Optional(
        Type.Array(workflowAccumulatedLogSchema, { maxItems: MAX_WORKFLOW_LOG_LINES }),
    ),
    logsTruncated: Type.Optional(Type.Boolean()),
    legacyStatus: Type.Optional(workflowLegacyStatusSchema),
};
const workflowStartedAtSchema = workflowTimestampSchema;
const workflowPausedAtSchema = workflowTimestampSchema;
const workflowFinishedAtSchema = workflowTimestampSchema;
const workflowOutputSchema = Type.String({ maxLength: MAX_WORKFLOW_OUTPUT_CHARACTERS });
const workflowErrorSchema = Type.String({ maxLength: MAX_WORKFLOW_ERROR_LENGTH });

export const workflowQueuedRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("queued"),
    },
    { additionalProperties: false },
);

export const workflowRunningRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("running"),
        startedAt: workflowStartedAtSchema,
        output: Type.Optional(workflowOutputSchema),
    },
    { additionalProperties: false },
);

export const workflowPausedRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("paused"),
        startedAt: workflowStartedAtSchema,
        pausedAt: workflowPausedAtSchema,
        output: Type.Optional(workflowOutputSchema),
    },
    { additionalProperties: false },
);

export const workflowCompletedRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("completed"),
        startedAt: workflowStartedAtSchema,
        finishedAt: workflowFinishedAtSchema,
        output: Type.Optional(workflowOutputSchema),
    },
    { additionalProperties: false },
);

export const workflowFailedRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("failed"),
        startedAt: workflowStartedAtSchema,
        finishedAt: workflowFinishedAtSchema,
        output: Type.Optional(workflowOutputSchema),
        error: workflowErrorSchema,
    },
    { additionalProperties: false },
);

export const workflowCancelledRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("cancelled"),
        startedAt: Type.Optional(workflowStartedAtSchema),
        finishedAt: workflowFinishedAtSchema,
        output: Type.Optional(workflowOutputSchema),
    },
    { additionalProperties: false },
);

export const workflowUnavailableRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("unavailable"),
        startedAt: Type.Optional(workflowStartedAtSchema),
        finishedAt: workflowFinishedAtSchema,
        output: Type.Optional(workflowOutputSchema),
        error: Type.Optional(workflowErrorSchema),
    },
    { additionalProperties: false },
);

/** Exact status-specific persisted workflow state. */
export const workflowRunSchema = Type.Union([
    workflowQueuedRunSchema,
    workflowRunningRunSchema,
    workflowPausedRunSchema,
    workflowCompletedRunSchema,
    workflowFailedRunSchema,
    workflowCancelledRunSchema,
    workflowUnavailableRunSchema,
]);

/**
 * Canonical observation returned by WorkflowsModule after it fills omitted runtime observations.
 * The runtime contract stays backward-compatible, while status and wait callers always receive
 * the agent count, bounded accumulated logs, truncation marker, and legacy status projection.
 */
export const workflowObservedRunSchema = Type.Intersect([
    workflowRunSchema,
    Type.Object(
        {
            agentCount: workflowAgentCountSchema,
            logs: Type.Array(workflowAccumulatedLogSchema, { maxItems: MAX_WORKFLOW_LOG_LINES }),
            logsTruncated: Type.Boolean(),
            legacyStatus: workflowLegacyStatusSchema,
        },
        { additionalProperties: true },
    ),
]);

const workflowLaunchScriptFields = {
    args: Type.Optional(workflowArgsSchema),
    description: Type.Optional(workflowDescriptionSchema),
    name: Type.Optional(workflowNameSchema),
    resumeFromRunId: Type.Optional(workflowIdSchema),
};

const workflowNamedLaunchInputSchema = Type.Object(
    {
        workflow: workflowNameSchema,
        input: Type.Optional(workflowInputSchema),
        operationId: Type.Optional(workflowIdSchema),
    },
    { additionalProperties: false },
);

const workflowScriptLaunchInputSchema = Type.Object(
    {
        ...workflowLaunchScriptFields,
        script: workflowScriptSchema,
    },
    { additionalProperties: false },
);

const workflowScriptPathLaunchInputSchema = Type.Object(
    {
        ...workflowLaunchScriptFields,
        scriptPath: workflowScriptPathSchema,
    },
    { additionalProperties: false },
);

/**
 * Launch input accepted by the public module API. A named host workflow is kept for runtimes that
 * already provide orchestration; script and scriptPath are the legacy-compatible orchestration
 * forms and are normalized to a host workflow name before launch.
 */
export const workflowLaunchInputSchema = Type.Union([
    workflowNamedLaunchInputSchema,
    Type.Object(
        {
            ...workflowLaunchScriptFields,
            script: workflowScriptSchema,
            operationId: Type.Optional(workflowIdSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workflowLaunchScriptFields,
            scriptPath: workflowScriptPathSchema,
            operationId: Type.Optional(workflowIdSchema),
        },
        { additionalProperties: false },
    ),
]);

/** Exact normalized launch request sent to the host runner. */
export const workflowLaunchRequestSchema = Type.Union([
    Type.Object(
        {
            workflow: workflowNameSchema,
            input: Type.Optional(workflowInputSchema),
            operationId: workflowIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            workflow: workflowNameSchema,
            input: Type.Optional(workflowInputSchema),
            ...workflowLaunchScriptFields,
            script: workflowScriptSchema,
            operationId: workflowIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            workflow: workflowNameSchema,
            input: Type.Optional(workflowInputSchema),
            ...workflowLaunchScriptFields,
            scriptPath: workflowScriptPathSchema,
            operationId: workflowIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export const workflowLaunchToolInputSchema = Type.Union([
    Type.Object(
        {
            workflow: workflowNameSchema,
            input: Type.Optional(workflowInputSchema),
        },
        { additionalProperties: false },
    ),
    workflowScriptLaunchInputSchema,
    workflowScriptPathLaunchInputSchema,
]);

export const workflowMutationInputSchema = Type.Object(
    {
        id: workflowIdSchema,
        operationId: Type.Optional(workflowIdSchema),
    },
    { additionalProperties: false },
);

/** Exact normalized mutation request sent to the host runner. */
export const workflowMutationRequestSchema = Type.Object(
    {
        id: workflowIdSchema,
        operationId: workflowIdSchema,
    },
    { additionalProperties: false },
);

export const workflowMutationToolInputSchema = Type.Object(
    {
        id: workflowIdSchema,
    },
    { additionalProperties: false },
);

export const workflowCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKFLOW_CURSOR,
});

export const workflowPageFromSchema = Type.Union([Type.Literal("start"), Type.Literal("end")]);

const workflowPageQueryFields = {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_PAGE_SIZE })),
    includeTerminal: Type.Optional(Type.Boolean()),
};

export const workflowPageQuerySchema = Type.Union([
    Type.Object(
        {
            ...workflowPageQueryFields,
            cursor: Type.Optional(workflowCursorSchema),
            from: Type.Optional(Type.Literal("start")),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workflowPageQueryFields,
            from: Type.Literal("end"),
        },
        { additionalProperties: false },
    ),
]);

export const workflowPageSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        cursor: workflowCursorSchema,
        runs: Type.Array(workflowRunSchema, { maxItems: MAX_WORKFLOW_PAGE_SIZE }),
        totalRuns: workflowCursorSchema,
        nextCursor: Type.Optional(workflowCursorSchema),
        previousCursor: Type.Optional(workflowCursorSchema),
    },
    { additionalProperties: false },
);

const workflowLogQueryFields = {
    id: workflowIdSchema,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_LINES })),
};

export const workflowLogQuerySchema = Type.Union([
    Type.Object(
        {
            ...workflowLogQueryFields,
            cursor: Type.Optional(workflowCursorSchema),
            from: Type.Optional(Type.Literal("start")),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workflowLogQueryFields,
            from: Type.Literal("end"),
        },
        { additionalProperties: false },
    ),
]);

export const workflowLogLineSchema = Type.Object(
    {
        position: Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_CURSOR }),
        text: Type.String({ maxLength: MAX_WORKFLOW_LOG_LINE_LENGTH }),
    },
    { additionalProperties: false },
);

export const workflowLogPageSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        id: workflowIdSchema,
        cursor: workflowCursorSchema,
        lines: Type.Array(workflowLogLineSchema, { maxItems: MAX_WORKFLOW_LOG_LINES }),
        totalLines: workflowCursorSchema,
        nextCursor: Type.Optional(workflowCursorSchema),
        previousCursor: Type.Optional(workflowCursorSchema),
    },
    { additionalProperties: false },
);

export const workflowMutationResultSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        operationId: workflowIdSchema,
        run: workflowRunSchema,
        changed: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type WorkflowId = Static<typeof workflowIdSchema>;
export type WorkflowAgentId = Static<typeof workflowAgentIdSchema>;
export type WorkflowName = Static<typeof workflowNameSchema>;
export type WorkflowInput = Static<typeof workflowInputSchema>;
export type WorkflowScript = Static<typeof workflowScriptSchema>;
export type WorkflowScriptPath = Static<typeof workflowScriptPathSchema>;
export type WorkflowDescription = Static<typeof workflowDescriptionSchema>;
export type WorkflowArgs = Static<typeof workflowArgsSchema>;
export type WorkflowStatus = Static<typeof workflowStatusSchema>;
export type WorkflowAgentCount = Static<typeof workflowAgentCountSchema>;
export type WorkflowAccumulatedLog = Static<typeof workflowAccumulatedLogSchema>;
export type WorkflowQueuedRun = Static<typeof workflowQueuedRunSchema>;
export type WorkflowRunningRun = Static<typeof workflowRunningRunSchema>;
export type WorkflowPausedRun = Static<typeof workflowPausedRunSchema>;
export type WorkflowCompletedRun = Static<typeof workflowCompletedRunSchema>;
export type WorkflowFailedRun = Static<typeof workflowFailedRunSchema>;
export type WorkflowCancelledRun = Static<typeof workflowCancelledRunSchema>;
export type WorkflowUnavailableRun = Static<typeof workflowUnavailableRunSchema>;
export type WorkflowRun = Static<typeof workflowRunSchema>;
export type WorkflowObservedRun = Static<typeof workflowObservedRunSchema>;
export type WorkflowLaunchInput = Static<typeof workflowLaunchInputSchema>;
export type WorkflowLaunchRequest = Static<typeof workflowLaunchRequestSchema>;
export type WorkflowLaunchToolInput = Static<typeof workflowLaunchToolInputSchema>;
export type WorkflowMutationInput = Static<typeof workflowMutationInputSchema>;
export type WorkflowMutationRequest = Static<typeof workflowMutationRequestSchema>;
export type WorkflowMutationToolInput = Static<typeof workflowMutationToolInputSchema>;
export type WorkflowMutationResult = Static<typeof workflowMutationResultSchema>;
export type WorkflowCursor = Static<typeof workflowCursorSchema>;
export type WorkflowPageFrom = Static<typeof workflowPageFromSchema>;
export type WorkflowPageQuery = Static<typeof workflowPageQuerySchema>;
export type WorkflowPage = Static<typeof workflowPageSchema>;
export type WorkflowLogQuery = Static<typeof workflowLogQuerySchema>;
export type WorkflowLogLine = Static<typeof workflowLogLineSchema>;
export type WorkflowLogPage = Static<typeof workflowLogPageSchema>;

/** Project the richer lifecycle into the four statuses used by the legacy workflow tools. */
export function workflowLegacyStatusFor(status: WorkflowStatus): WorkflowLegacyStatus {
    switch (status) {
        case "completed":
            return "completed";
        case "failed":
        case "unavailable":
            return "error";
        case "cancelled":
            return "stopped";
        case "queued":
        case "running":
        case "paused":
            return "running";
    }
}
