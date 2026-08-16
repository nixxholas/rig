import { Type, type Static } from "@sinclair/typebox";

export const MAX_HAPPY_AGENT_ID_LENGTH = 256;
export const MAX_HAPPY_NOTIFICATION_ID_LENGTH = 128;
export const MAX_HAPPY_TITLE_LENGTH = 160;
export const MAX_HAPPY_BODY_LENGTH = 8_000;
export const MAX_HAPPY_STATUS_MESSAGE_LENGTH = 1_000;
export const MAX_HAPPY_NOTIFICATIONS = 100;
export const MAX_HAPPY_OUTPUT_CHARACTERS = 12_000;

const noLineBreaks = "^[^\\u0000\\r\\n]+$";

export const happyAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HAPPY_AGENT_ID_LENGTH,
    pattern: noLineBreaks,
});
export const happyNotificationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HAPPY_NOTIFICATION_ID_LENGTH,
    pattern: noLineBreaks,
});
export const happyNotificationLevelSchema = Type.Union([
    Type.Literal("info"),
    Type.Literal("success"),
    Type.Literal("warning"),
    Type.Literal("error"),
]);
export const happyStatusSchema = Type.Union([
    Type.Literal("idle"),
    Type.Literal("working"),
    Type.Literal("waiting"),
    Type.Literal("blocked"),
    Type.Literal("done"),
]);
export const happyNotificationInputSchema = Type.Object(
    {
        body: Type.String({ minLength: 1, maxLength: MAX_HAPPY_BODY_LENGTH }),
        level: Type.Optional(happyNotificationLevelSchema),
        title: Type.Optional(Type.String({ maxLength: MAX_HAPPY_TITLE_LENGTH })),
    },
    { additionalProperties: false },
);
export const happyNotificationToolInputSchema = Type.Object(
    {
        body: Type.String({ minLength: 1, maxLength: MAX_HAPPY_BODY_LENGTH }),
        level: Type.Optional(happyNotificationLevelSchema),
        title: Type.Optional(Type.String({ maxLength: MAX_HAPPY_TITLE_LENGTH })),
    },
    { additionalProperties: false },
);
export const happyStatusInputSchema = Type.Object(
    {
        message: Type.Optional(Type.String({ maxLength: MAX_HAPPY_STATUS_MESSAGE_LENGTH })),
        status: happyStatusSchema,
    },
    { additionalProperties: false },
);
export const happyStatusToolInputSchema = Type.Object(
    {
        message: Type.Optional(Type.String({ maxLength: MAX_HAPPY_STATUS_MESSAGE_LENGTH })),
        status: happyStatusSchema,
    },
    { additionalProperties: false },
);
export const happyNotificationSchema = Type.Object(
    {
        body: Type.String({ minLength: 1, maxLength: MAX_HAPPY_BODY_LENGTH }),
        createdAt: Type.Integer({ minimum: 0 }),
        id: happyNotificationIdSchema,
        level: happyNotificationLevelSchema,
        title: Type.Optional(Type.String({ maxLength: MAX_HAPPY_TITLE_LENGTH })),
    },
    { additionalProperties: false },
);
export const happyStatusRecordSchema = Type.Object(
    {
        agentId: happyAgentIdSchema,
        message: Type.Optional(Type.String({ maxLength: MAX_HAPPY_STATUS_MESSAGE_LENGTH })),
        status: happyStatusSchema,
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export const happyDeliveryResultSchema = Type.Object(
    {
        accepted: Type.Boolean(),
        receiptId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
export const happyModuleEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("happy_notification_created"),
            at: Type.Integer({ minimum: 0 }),
            eventId: Type.String({ minLength: 1, maxLength: 128 }),
            notification: happyNotificationSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("happy_status_changed"),
            at: Type.Integer({ minimum: 0 }),
            eventId: Type.String({ minLength: 1, maxLength: 128 }),
            previous: Type.Optional(happyStatusRecordSchema),
            current: happyStatusRecordSchema,
        },
        { additionalProperties: false },
    ),
]);

export type HappyAgentId = Static<typeof happyAgentIdSchema>;
export type HappyNotificationLevel = Static<typeof happyNotificationLevelSchema>;
export type HappyStatus = Static<typeof happyStatusSchema>;
export type HappyNotificationInput = Static<typeof happyNotificationInputSchema>;
export type HappyNotificationToolInput = Static<typeof happyNotificationToolInputSchema>;
export type HappyStatusInput = Static<typeof happyStatusInputSchema>;
export type HappyStatusToolInput = Static<typeof happyStatusToolInputSchema>;
export type HappyNotification = Static<typeof happyNotificationSchema>;
export type HappyStatusRecord = Static<typeof happyStatusRecordSchema>;
export type HappyDeliveryResult = Static<typeof happyDeliveryResultSchema>;
export type HappyModuleEvent = Static<typeof happyModuleEventSchema>;
