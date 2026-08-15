import { Type, type Static } from "@sinclair/typebox";

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

export const workflowStatusSchema = Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("unavailable"),
]);

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

export const workflowLaunchInputSchema = Type.Object(
    {
        workflow: workflowNameSchema,
        input: Type.Optional(workflowInputSchema),
        operationId: Type.Optional(workflowIdSchema),
    },
    { additionalProperties: false },
);

/** Exact normalized launch request sent to the host runner. */
export const workflowLaunchRequestSchema = Type.Object(
    {
        workflow: workflowNameSchema,
        input: Type.Optional(workflowInputSchema),
        operationId: workflowIdSchema,
    },
    { additionalProperties: false },
);

export const workflowLaunchToolInputSchema = Type.Object(
    {
        workflow: workflowNameSchema,
        input: Type.Optional(workflowInputSchema),
    },
    { additionalProperties: false },
);

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
export type WorkflowStatus = Static<typeof workflowStatusSchema>;
export type WorkflowQueuedRun = Static<typeof workflowQueuedRunSchema>;
export type WorkflowRunningRun = Static<typeof workflowRunningRunSchema>;
export type WorkflowPausedRun = Static<typeof workflowPausedRunSchema>;
export type WorkflowCompletedRun = Static<typeof workflowCompletedRunSchema>;
export type WorkflowFailedRun = Static<typeof workflowFailedRunSchema>;
export type WorkflowCancelledRun = Static<typeof workflowCancelledRunSchema>;
export type WorkflowUnavailableRun = Static<typeof workflowUnavailableRunSchema>;
export type WorkflowRun = Static<typeof workflowRunSchema>;
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
