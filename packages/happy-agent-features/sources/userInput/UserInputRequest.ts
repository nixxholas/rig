import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The largest timestamp accepted by the feature and its host adapter. */
export const MAX_USER_INPUT_TIMESTAMP = 8_640_000_000_000_000;

export const MAX_USER_INPUT_AGENT_ID_LENGTH = 128;
export const MAX_USER_INPUT_REQUEST_ID_LENGTH = 128;
export const MAX_USER_INPUT_OPERATION_ID_LENGTH = 128;
export const MAX_USER_INPUT_EVENT_ID_LENGTH = 128;
/** SHA-256 hex digests keep receipts bounded independently of request payload size. */
export const MAX_USER_INPUT_FINGERPRINT_LENGTH = 64;
export const MAX_USER_INPUT_CURSOR_LENGTH = 512;

export const MAX_USER_INPUT_QUESTION_CHARACTERS = 4_000;
export const MAX_USER_INPUT_CONTEXT_CHARACTERS = 100_000;
export const MAX_USER_INPUT_ANSWER_CHARACTERS = 20_000;
export const MAX_USER_INPUT_OPTION_COUNT = 32;
export const MAX_USER_INPUT_OPTION_LABEL_CHARACTERS = 256;
export const MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS = 2_000;
export const MAX_USER_INPUT_CANCEL_REASON_CHARACTERS = 2_000;
export const MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS = 4_000;
export const MAX_USER_INPUT_DETAIL_TOTAL_CHARACTERS = 200_000;

export const userInputTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_USER_INPUT_TIMESTAMP,
});
export const userInputAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_AGENT_ID_LENGTH,
});
export const userInputRequestIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_REQUEST_ID_LENGTH,
});
export const userInputOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_OPERATION_ID_LENGTH,
});
export const userInputEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_EVENT_ID_LENGTH,
});
export const userInputFingerprintSchema = Type.String({
    minLength: MAX_USER_INPUT_FINGERPRINT_LENGTH,
    maxLength: MAX_USER_INPUT_FINGERPRINT_LENGTH,
    pattern: "^[0-9a-f]{64}$",
});

export const userInputQuestionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_QUESTION_CHARACTERS,
});
export const userInputContextSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_CONTEXT_CHARACTERS,
});
export const userInputAnswerTextSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_ANSWER_CHARACTERS,
});
export const userInputOptionLabelSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_OPTION_LABEL_CHARACTERS,
});
export const userInputOptionDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS,
});
export const userInputCancelReasonSchema = Type.String({
    minLength: 1,
    maxLength: MAX_USER_INPUT_CANCEL_REASON_CHARACTERS,
});

/** A bounded choice shown alongside the free-form answer field. */
export const userInputChoiceSchema = Type.Object(
    {
        label: userInputOptionLabelSchema,
        description: userInputOptionDescriptionSchema,
    },
    { additionalProperties: false },
);

export const userInputOptionsSchema = Type.Object(
    {
        choices: Type.Array(userInputChoiceSchema, {
            minItems: 1,
            maxItems: MAX_USER_INPUT_OPTION_COUNT,
        }),
        multiSelect: Type.Boolean(),
    },
    { additionalProperties: false },
);

/**
 * Answers may be a plain free-form string or a structured payload containing both a free-form
 * explanation and selected choice labels. The feature validates selected labels against the
 * request's declared choices before persisting them.
 */
const userInputSelectedOptionsSchema = Type.Array(userInputOptionLabelSchema, {
    minItems: 1,
    maxItems: MAX_USER_INPUT_OPTION_COUNT,
});

const userInputAnswerWithTextSchema = Type.Object(
    {
        text: userInputAnswerTextSchema,
        selectedOptions: Type.Optional(userInputSelectedOptionsSchema),
    },
    { additionalProperties: false },
);

const userInputAnswerWithSelectedOptionsSchema = Type.Object(
    {
        text: Type.Optional(userInputAnswerTextSchema),
        selectedOptions: userInputSelectedOptionsSchema,
    },
    { additionalProperties: false },
);

/** A structured answer must carry text, selected options, or both. */
export const userInputAnswerObjectSchema = Type.Union([
    userInputAnswerWithTextSchema,
    userInputAnswerWithSelectedOptionsSchema,
]);
export const userInputAnswerSchema = Type.Union([
    userInputAnswerTextSchema,
    userInputAnswerObjectSchema,
]);

export const userInputRequestCommonProperties = {
    id: userInputRequestIdSchema,
    askingAgentId: userInputAgentIdSchema,
    question: userInputQuestionSchema,
    context: userInputContextSchema,
    options: Type.Optional(userInputOptionsSchema),
    deadlineAt: Type.Optional(userInputTimestampSchema),
    createdAt: userInputTimestampSchema,
    updatedAt: userInputTimestampSchema,
} as const;

/**
 * A request is a discriminated union. A terminal row always names its outcome and carries the
 * fields needed to explain that outcome without consulting the chat transcript.
 */
const userInputPendingRequestSchema = Type.Object(
    {
        ...userInputRequestCommonProperties,
        status: Type.Literal("pending"),
    },
    { additionalProperties: false },
);

const userInputAnsweredRequestSchema = Type.Object(
    {
        ...userInputRequestCommonProperties,
        status: Type.Literal("answered"),
        answer: userInputAnswerSchema,
        answeredAt: userInputTimestampSchema,
    },
    { additionalProperties: false },
);

const userInputCancelledRequestSchema = Type.Object(
    {
        ...userInputRequestCommonProperties,
        status: Type.Literal("cancelled"),
        reason: userInputCancelReasonSchema,
        cancelledAt: Type.Optional(userInputTimestampSchema),
    },
    { additionalProperties: false },
);

const userInputAwayRequestSchema = Type.Object(
    {
        ...userInputRequestCommonProperties,
        status: Type.Literal("away"),
        completedAt: Type.Optional(userInputTimestampSchema),
    },
    { additionalProperties: false },
);

const userInputTimedOutRequestSchema = Type.Object(
    {
        ...userInputRequestCommonProperties,
        status: Type.Literal("timed_out"),
        deadlineAt: userInputTimestampSchema,
        timedOutAt: Type.Optional(userInputTimestampSchema),
    },
    { additionalProperties: false },
);

export const userInputRequestSchema = Type.Union([
    userInputPendingRequestSchema,
    userInputAnsweredRequestSchema,
    userInputCancelledRequestSchema,
    userInputAwayRequestSchema,
    userInputTimedOutRequestSchema,
]);

/** A durable wait resolves only after the request has reached a terminal outcome. */
export const userInputTerminalRequestSchema = Type.Union([
    userInputAnsweredRequestSchema,
    userInputCancelledRequestSchema,
    userInputAwayRequestSchema,
    userInputTimedOutRequestSchema,
]);

export const userInputStatusSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("answered"),
    Type.Literal("cancelled"),
    Type.Literal("away"),
    Type.Literal("timed_out"),
]);
export const userInputListStatusSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("terminal"),
]);

export const userInputAskInputSchema = Type.Object(
    {
        operationId: Type.Optional(userInputOperationIdSchema),
        question: userInputQuestionSchema,
        context: userInputContextSchema,
        options: Type.Optional(userInputOptionsSchema),
        deadlineAt: Type.Optional(userInputTimestampSchema),
    },
    { additionalProperties: false },
);

/** Feature-owned IDs are deliberately absent from the model-facing schema. */
export const userInputToolInputSchema = Type.Omit(userInputAskInputSchema, ["operationId"]);

export const userInputWaitInputSchema = Type.Object(
    {
        operationId: Type.Optional(userInputOperationIdSchema),
        requestId: userInputRequestIdSchema,
    },
    { additionalProperties: false },
);
export const userInputWaitToolInputSchema = Type.Omit(userInputWaitInputSchema, ["operationId"]);

export const userInputAnswerInputSchema = Type.Object(
    {
        operationId: Type.Optional(userInputOperationIdSchema),
        requestId: userInputRequestIdSchema,
        answer: userInputAnswerSchema,
    },
    { additionalProperties: false },
);

export const userInputCancelInputSchema = Type.Object(
    {
        operationId: Type.Optional(userInputOperationIdSchema),
        requestId: userInputRequestIdSchema,
        reason: userInputCancelReasonSchema,
    },
    { additionalProperties: false },
);

export const userInputCompleteOutcomeSchema = Type.Union([
    Type.Object(
        {
            outcome: Type.Literal("away"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            outcome: Type.Literal("timed_out"),
            deadlineAt: userInputTimestampSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            outcome: Type.Literal("cancelled"),
            reason: userInputCancelReasonSchema,
        },
        { additionalProperties: false },
    ),
]);

export const userInputCompleteInputSchema = Type.Union([
    Type.Object(
        {
            operationId: Type.Optional(userInputOperationIdSchema),
            requestId: userInputRequestIdSchema,
            outcome: Type.Literal("away"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operationId: Type.Optional(userInputOperationIdSchema),
            requestId: userInputRequestIdSchema,
            outcome: Type.Literal("timed_out"),
            deadlineAt: userInputTimestampSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operationId: Type.Optional(userInputOperationIdSchema),
            requestId: userInputRequestIdSchema,
            outcome: Type.Literal("cancelled"),
            reason: userInputCancelReasonSchema,
        },
        { additionalProperties: false },
    ),
]);

export const userInputListQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_USER_INPUT_CURSOR_LENGTH })),
        status: Type.Optional(userInputListStatusSchema),
        askingAgentId: Type.Optional(userInputAgentIdSchema),
    },
    { additionalProperties: false },
);

export const userInputPageSchema = Type.Object(
    {
        requests: Type.Array(userInputRequestSchema, { maxItems: 100 }),
        /** Absolute source position of the first returned request. */
        cursor: Type.String({
            minLength: 1,
            maxLength: MAX_USER_INPUT_CURSOR_LENGTH,
        }),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
        previousCursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_USER_INPUT_CURSOR_LENGTH }),
        ),
        nextCursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_USER_INPUT_CURSOR_LENGTH }),
        ),
    },
    { additionalProperties: false },
);

/** Cursor-addressable detail output. The cursor is a decimal character offset owned by this feature. */
export const userInputDetailQuerySchema = Type.Object(
    {
        cursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_USER_INPUT_CURSOR_LENGTH }),
        ),
        limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS }),
        ),
        /** Offset aliases match the other bounded detail features in this package. */
        detailOffset: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_USER_INPUT_DETAIL_TOTAL_CHARACTERS }),
        ),
        detailLimit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS }),
        ),
    },
    { additionalProperties: false },
);

export const userInputDetailPageSchema = Type.Object(
    {
        request: Type.Union([userInputRequestSchema, Type.Null()]),
        detail: Type.String({ maxLength: MAX_USER_INPUT_DETAIL_TOTAL_CHARACTERS }),
        cursor: Type.Integer({ minimum: 0, maximum: MAX_USER_INPUT_DETAIL_TOTAL_CHARACTERS }),
        detailTotal: Type.Integer({
            minimum: 0,
            maximum: MAX_USER_INPUT_DETAIL_TOTAL_CHARACTERS,
        }),
        nextCursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_USER_INPUT_CURSOR_LENGTH }),
        ),
    },
    { additionalProperties: false },
);

export type UserInputTimestamp = Static<typeof userInputTimestampSchema>;
export type UserInputAgentId = Static<typeof userInputAgentIdSchema>;
export type UserInputQuestion = Static<typeof userInputQuestionSchema>;
export type UserInputRequestId = Static<typeof userInputRequestIdSchema>;
export type UserInputOperationId = Static<typeof userInputOperationIdSchema>;
export type UserInputEventId = Static<typeof userInputEventIdSchema>;
export type UserInputFingerprint = Static<typeof userInputFingerprintSchema>;
export type UserInputChoice = Static<typeof userInputChoiceSchema>;
export type UserInputOptions = Static<typeof userInputOptionsSchema>;
export type UserInputAnswer = Static<typeof userInputAnswerSchema>;
export type UserInputRequest = Static<typeof userInputRequestSchema>;
export type UserInputTerminalRequest = Static<typeof userInputTerminalRequestSchema>;
export type UserInputStatus = Static<typeof userInputStatusSchema>;
export type UserInputListStatus = Static<typeof userInputListStatusSchema>;
export type UserInputAskInput = Static<typeof userInputAskInputSchema>;
export type UserInputToolInput = Static<typeof userInputToolInputSchema>;
export type UserInputWaitInput = Static<typeof userInputWaitInputSchema>;
export type UserInputWaitToolInput = Static<typeof userInputWaitToolInputSchema>;
export type UserInputAnswerInput = Static<typeof userInputAnswerInputSchema>;
export type UserInputCancelInput = Static<typeof userInputCancelInputSchema>;
export type UserInputCompleteOutcome = Static<typeof userInputCompleteOutcomeSchema>;
export type UserInputCompleteInput = Static<typeof userInputCompleteInputSchema>;
export type UserInputListQuery = Static<typeof userInputListQuerySchema>;
export type UserInputPage = Static<typeof userInputPageSchema>;
export type UserInputDetailQuery = Static<typeof userInputDetailQuerySchema>;
export type UserInputDetailPage = Static<typeof userInputDetailPageSchema>;

export function assertUserInputRequest(value: unknown): asserts value is UserInputRequest {
    if (!Value.Check(userInputRequestSchema, value)) {
        throw new Error("User input store returned an invalid request.");
    }
    const request = value as UserInputRequest;
    if (request.updatedAt < request.createdAt) {
        throw new Error("User input request timestamps are out of order.");
    }
    if (request.deadlineAt !== undefined && request.deadlineAt < request.createdAt) {
        throw new Error("User input request deadline precedes its creation.");
    }
    assertUserInputOptions(request.options);
    if (request.status === "answered") {
        assertUserInputAnswer(request.answer, request.options);
        if (request.answeredAt < request.createdAt) {
            throw new Error("User input answer timestamp precedes request creation.");
        }
    }
    if (
        request.status === "cancelled" &&
        request.cancelledAt !== undefined &&
        request.cancelledAt < request.createdAt
    ) {
        throw new Error("User input cancellation timestamp precedes request creation.");
    }
    if (
        request.status === "away" &&
        request.completedAt !== undefined &&
        request.completedAt < request.createdAt
    ) {
        throw new Error("User input completion timestamp precedes request creation.");
    }
    if (
        request.status === "timed_out" &&
        request.timedOutAt !== undefined &&
        request.timedOutAt < request.createdAt
    ) {
        throw new Error("User input timeout timestamp precedes request creation.");
    }
    if (
        request.status === "timed_out" &&
        request.timedOutAt !== undefined &&
        request.timedOutAt < request.deadlineAt
    ) {
        throw new Error("User input timeout timestamp precedes its deadline.");
    }
}

export function assertUserInputOptions(value: UserInputOptions | undefined): void {
    if (value === undefined) return;
    const labels = new Set<string>();
    for (const choice of value.choices) {
        if (labels.has(choice.label)) {
            throw new Error("User input choices must have unique labels.");
        }
        labels.add(choice.label);
    }
}

export function assertUserInputAnswer(
    value: UserInputAnswer,
    options: UserInputOptions | undefined,
): void {
    if (typeof value === "string") return;
    if (value.text === undefined && value.selectedOptions === undefined) {
        throw new Error("A structured user input answer must contain text or selected options.");
    }
    if (value.selectedOptions === undefined) return;
    const labels = new Set(options?.choices.map((choice) => choice.label) ?? []);
    const selected = new Set<string>();
    for (const label of value.selectedOptions) {
        if (selected.has(label)) {
            throw new Error("User input answers cannot select one option twice.");
        }
        selected.add(label);
        if (options === undefined || !labels.has(label)) {
            throw new Error(`User input answer selected an undeclared option "${label}".`);
        }
    }
    if (options !== undefined && !options.multiSelect && value.selectedOptions.length > 1) {
        throw new Error("This user input request permits only one selected option.");
    }
}

export function isUserInputTerminal(
    request: UserInputRequest,
): request is Exclude<UserInputRequest, { status: "pending" }> {
    return request.status !== "pending";
}