import { Type, type Static } from "@sinclair/typebox";

/**
 * Scheduling deliberately keeps its identities independent from Collaboration. Hosts may use
 * whatever stable identity namespace they prefer; these bounds merely keep records and model
 * output finite.
 */
export const MAX_SCHEDULING_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_SCHEDULING_ID_LENGTH = 128;
export const MAX_SCHEDULING_MESSAGE_LENGTH = 50_000;
export const MAX_SCHEDULING_FAILURE_LENGTH = 2_000;
export const MAX_SCHEDULING_PAGE_SIZE = 100;
export const MAX_SCHEDULING_CURSOR_LENGTH = 512;
export const MAX_SCHEDULING_DETAIL_PAGE_SIZE = 4_096;

const identityPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";

export const schedulingAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SCHEDULING_ID_LENGTH,
    pattern: identityPattern,
});
export const schedulingWaitIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SCHEDULING_ID_LENGTH,
    pattern: identityPattern,
});
export const schedulingMessageIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SCHEDULING_ID_LENGTH,
    pattern: identityPattern,
});
export const schedulingEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SCHEDULING_ID_LENGTH,
    pattern: identityPattern,
});
export const schedulingTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_SCHEDULING_TIMESTAMP,
});

const durationValueSchema = Type.Number({
    minimum: 0,
    maximum: MAX_SCHEDULING_TIMESTAMP,
});

/**
 * The model-facing duration is a deliberately small discriminated union. It avoids asking a
 * model to invent a duration grammar while still allowing useful fractional values such as
 * `1.5` hours when they resolve to a whole number of milliseconds.
 */
export const schedulingDurationSchema = Type.Union([
    Type.Object(
        { unit: Type.Union([Type.Literal("seconds"), Type.Literal("second")]), value: durationValueSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { unit: Type.Union([Type.Literal("minutes"), Type.Literal("minute")]), value: durationValueSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { unit: Type.Union([Type.Literal("hours"), Type.Literal("hour")]), value: durationValueSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { unit: Type.Union([Type.Literal("days"), Type.Literal("day")]), value: durationValueSchema },
        { additionalProperties: false },
    ),
    Type.Object({ seconds: durationValueSchema }, { additionalProperties: false }),
    Type.Object({ minutes: durationValueSchema }, { additionalProperties: false }),
    Type.Object({ hours: durationValueSchema }, { additionalProperties: false }),
    Type.Object({ days: durationValueSchema }, { additionalProperties: false }),
]);

/** A timezone-bearing ISO-8601 instant. Semantic validation also checks Date.parse. */
export const schedulingInstantSchema = Type.String({
    minLength: 16,
    maxLength: 64,
    pattern:
        "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:\\d{2})$",
});

export const schedulingWaitKindSchema = Type.Union([
    Type.Literal("wait"),
    Type.Literal("wait_until"),
]);
export const schedulingWaitStatusSchema = Type.Union([
    Type.Literal("waiting"),
    Type.Literal("elapsed"),
    Type.Literal("interrupted"),
]);
export const schedulingWaitOutcomeSchema = Type.Union([
    Type.Literal("elapsed"),
    Type.Literal("interrupted"),
]);

const waitInputIdentity = {
    id: Type.Optional(schedulingWaitIdSchema),
};

export const schedulingWaitInputSchema = Type.Object(
    {
        ...waitInputIdentity,
        duration: schedulingDurationSchema,
    },
    { additionalProperties: false },
);

export const schedulingWaitUntilInputSchema = Type.Object(
    {
        ...waitInputIdentity,
        at: schedulingInstantSchema,
    },
    { additionalProperties: false },
);

/** Model schemas omit the record identity, which comes from the durable tool call. */
export const schedulingWaitToolInputSchema = Type.Omit(schedulingWaitInputSchema, ["id"]);
export const schedulingWaitUntilToolInputSchema = Type.Omit(schedulingWaitUntilInputSchema, ["id"]);

const waitRecordCommon = {
    id: schedulingWaitIdSchema,
    agentId: schedulingAgentIdSchema,
    kind: schedulingWaitKindSchema,
    dueAt: schedulingTimestampSchema,
    createdAt: schedulingTimestampSchema,
    updatedAt: schedulingTimestampSchema,
    startedAt: schedulingTimestampSchema,
};

export const schedulingWaitingRecordSchema = Type.Object(
    {
        ...waitRecordCommon,
        status: Type.Literal("waiting"),
    },
    { additionalProperties: false },
);

const terminalWaitRecordCommon = {
    ...waitRecordCommon,
    finishedAt: schedulingTimestampSchema,
    elapsedMs: Type.Integer({ minimum: 0, maximum: MAX_SCHEDULING_TIMESTAMP }),
};

export const schedulingElapsedRecordSchema = Type.Object(
    {
        ...terminalWaitRecordCommon,
        status: Type.Literal("elapsed"),
    },
    { additionalProperties: false },
);
export const schedulingInterruptedRecordSchema = Type.Object(
    {
        ...terminalWaitRecordCommon,
        status: Type.Literal("interrupted"),
    },
    { additionalProperties: false },
);
export const schedulingWaitRecordSchema = Type.Union([
    schedulingWaitingRecordSchema,
    schedulingElapsedRecordSchema,
    schedulingInterruptedRecordSchema,
]);

export const schedulingWaitResultSchema = Type.Object(
    {
        waitId: schedulingWaitIdSchema,
        agentId: schedulingAgentIdSchema,
        outcome: schedulingWaitOutcomeSchema,
        kind: schedulingWaitKindSchema,
        dueAt: schedulingTimestampSchema,
        startedAt: schedulingTimestampSchema,
        endedAt: schedulingTimestampSchema,
        elapsedMs: Type.Integer({ minimum: 0, maximum: MAX_SCHEDULING_TIMESTAMP }),
    },
    { additionalProperties: false },
);

export const schedulingWaitSettlementSchema = Type.Union([
    schedulingWaitResultSchema,
    schedulingElapsedRecordSchema,
    schedulingInterruptedRecordSchema,
]);

export const schedulingScheduleStatusSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("delivered"),
    Type.Literal("undelivered"),
    Type.Literal("cancelled"),
]);

export const schedulingScheduledMessageSchema = Type.Object(
    {
        id: schedulingMessageIdSchema,
        senderAgentId: schedulingAgentIdSchema,
        targetAgentId: schedulingAgentIdSchema,
        message: Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_MESSAGE_LENGTH }),
        dueAt: schedulingTimestampSchema,
        status: schedulingScheduleStatusSchema,
        createdAt: schedulingTimestampSchema,
        updatedAt: schedulingTimestampSchema,
        deliveredAt: Type.Optional(schedulingTimestampSchema),
        failure: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_FAILURE_LENGTH }),
        ),
        deliveryAttempts: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000 })),
    },
    { additionalProperties: false },
);

export const schedulingScheduleInputSchema = Type.Union([
    Type.Object(
        {
            id: Type.Optional(schedulingMessageIdSchema),
            targetAgentId: Type.Optional(schedulingAgentIdSchema),
            message: Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_MESSAGE_LENGTH }),
            in: schedulingDurationSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            id: Type.Optional(schedulingMessageIdSchema),
            targetAgentId: Type.Optional(schedulingAgentIdSchema),
            message: Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_MESSAGE_LENGTH }),
            at: schedulingInstantSchema,
        },
        { additionalProperties: false },
    ),
]);

/** Model-facing scheduling never exposes a target or the durable call identity. */
export const schedulingScheduleToolInputSchema = Type.Union([
    Type.Object(
        {
            message: Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_MESSAGE_LENGTH }),
            in: schedulingDurationSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            message: Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_MESSAGE_LENGTH }),
            at: schedulingInstantSchema,
        },
        { additionalProperties: false },
    ),
]);

export const schedulingCancelInputSchema = Type.Object(
    {
        scheduleId: schedulingMessageIdSchema,
    },
    { additionalProperties: false },
);
export const schedulingCancelToolInputSchema = schedulingCancelInputSchema;

export const schedulingSchedulePageQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SCHEDULING_PAGE_SIZE })),
        cursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_CURSOR_LENGTH }),
        ),
        status: Type.Optional(schedulingScheduleStatusSchema),
        senderAgentId: Type.Optional(schedulingAgentIdSchema),
        targetAgentId: Type.Optional(schedulingAgentIdSchema),
    },
    { additionalProperties: false },
);

export const schedulingScheduleToolPageQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SCHEDULING_PAGE_SIZE })),
        cursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_CURSOR_LENGTH }),
        ),
        status: Type.Optional(schedulingScheduleStatusSchema),
    },
    { additionalProperties: false },
);

export const schedulingSchedulePageSchema = Type.Object(
    {
        schedules: Type.Array(schedulingScheduledMessageSchema, {
            maxItems: MAX_SCHEDULING_PAGE_SIZE,
        }),
        limit: Type.Integer({ minimum: 1, maximum: MAX_SCHEDULING_PAGE_SIZE }),
        nextCursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_CURSOR_LENGTH }),
        ),
        previousCursor: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_CURSOR_LENGTH }),
        ),
    },
    { additionalProperties: false },
);

export const schedulingScheduleDetailQuerySchema = Type.Object(
    {
        detailOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
        detailLimit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_SCHEDULING_DETAIL_PAGE_SIZE }),
        ),
    },
    { additionalProperties: false },
);

export const schedulingScheduleDetailPageSchema = Type.Object(
    {
        schedule: Type.Union([schedulingScheduledMessageSchema, Type.Null()]),
        detail: Type.String({ maxLength: 1_000_000 }),
        detailOffset: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
        detailTotal: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
        nextDetailOffset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    },
    { additionalProperties: false },
);

const schedulingDeliveredOutcomeFields = {
    scheduleId: schedulingMessageIdSchema,
    status: Type.Literal("delivered"),
    deliveredAt: Type.Optional(schedulingTimestampSchema),
};
const schedulingUndeliveredOutcomeFields = {
    scheduleId: schedulingMessageIdSchema,
    status: Type.Literal("undelivered"),
    failure: Type.String({ minLength: 1, maxLength: MAX_SCHEDULING_FAILURE_LENGTH }),
};

/**
 * Delivery outcomes are intentionally a discriminated union. A successful delivery cannot also
 * carry a failure, and an undelivered message must retain bounded failure detail.
 */
export const schedulingDeliveryOutcomeInputSchema = Type.Union([
    Type.Object(schedulingDeliveredOutcomeFields, { additionalProperties: false }),
    Type.Object(schedulingUndeliveredOutcomeFields, { additionalProperties: false }),
]);

export const schedulingDeliveryOutcomeRequestSchema = schedulingDeliveryOutcomeInputSchema;

// Naming aliases keep the host-facing surface discoverable without introducing a second schema.
export const schedulingMessageSchema = schedulingScheduledMessageSchema;
export const schedulingMessagePageSchema = schedulingSchedulePageSchema;
export const schedulingMessagePageQuerySchema = schedulingSchedulePageQuerySchema;

export type SchedulingAgentId = Static<typeof schedulingAgentIdSchema>;
export type SchedulingWaitId = Static<typeof schedulingWaitIdSchema>;
export type SchedulingMessageId = Static<typeof schedulingMessageIdSchema>;
export type SchedulingEventId = Static<typeof schedulingEventIdSchema>;
export type SchedulingDuration = Static<typeof schedulingDurationSchema>;
export type SchedulingInstant = Static<typeof schedulingInstantSchema>;
export type SchedulingWaitKind = Static<typeof schedulingWaitKindSchema>;
export type SchedulingWaitStatus = Static<typeof schedulingWaitStatusSchema>;
export type SchedulingWaitOutcome = Static<typeof schedulingWaitOutcomeSchema>;
export type SchedulingWaitInput = Static<typeof schedulingWaitInputSchema>;
export type SchedulingWaitToolInput = Static<typeof schedulingWaitToolInputSchema>;
export type SchedulingWaitUntilInput = Static<typeof schedulingWaitUntilInputSchema>;
export type SchedulingWaitUntilToolInput = Static<typeof schedulingWaitUntilToolInputSchema>;
export type SchedulingWaitRecord = Static<typeof schedulingWaitRecordSchema>;
export type SchedulingWaitResult = Static<typeof schedulingWaitResultSchema>;
export type SchedulingWaitSettlement = Static<typeof schedulingWaitSettlementSchema>;
export type SchedulingScheduleStatus = Static<typeof schedulingScheduleStatusSchema>;
export type SchedulingScheduledMessage = Static<typeof schedulingScheduledMessageSchema>;
export type SchedulingMessage = SchedulingScheduledMessage;
export type SchedulingScheduleInput = Static<typeof schedulingScheduleInputSchema>;
export type SchedulingScheduleToolInput = Static<typeof schedulingScheduleToolInputSchema>;
export type SchedulingCancelInput = Static<typeof schedulingCancelInputSchema>;
export type SchedulingSchedulePageQuery = Static<typeof schedulingSchedulePageQuerySchema>;
export type SchedulingScheduleToolPageQuery = Static<
    typeof schedulingScheduleToolPageQuerySchema
>;
export type SchedulingSchedulePage = Static<typeof schedulingSchedulePageSchema>;
export type SchedulingMessagePage = SchedulingSchedulePage;
export type SchedulingMessagePageQuery = SchedulingSchedulePageQuery;
export type SchedulingScheduleDetailQuery = Static<typeof schedulingScheduleDetailQuerySchema>;
export type SchedulingScheduleDetailPage = Static<typeof schedulingScheduleDetailPageSchema>;
export type SchedulingDeliveryOutcomeInput = Static<
    typeof schedulingDeliveryOutcomeInputSchema
>;
export type SchedulingDeliveryOutcomeRequest = Static<
    typeof schedulingDeliveryOutcomeRequestSchema
>;