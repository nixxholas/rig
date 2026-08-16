import { Type, type Static } from "@sinclair/typebox";

import {
    COLLABORATION_MAX_TIMESTAMP,
    collaborationAgentIdSchema,
    collaborationAgentObservationSchema,
    collaborationMetadataSchema,
} from "./CollaborationAgent.js";

export const collaborationMessageIdSchema = Type.String({
    minLength: 2,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]*$",
});

export const collaborationObligationIdSchema = Type.String({
    minLength: 2,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]*$",
});

export const collaborationMessageTextSchema = Type.String({
    minLength: 1,
    maxLength: 50_000,
});

/** The durable message projected by the module-owned collaboration table. */
export const collaborationMessageSchema = Type.Object(
    {
        id: collaborationMessageIdSchema,
        fromAgentId: collaborationAgentIdSchema,
        toAgentId: collaborationAgentIdSchema,
        text: collaborationMessageTextSchema,
        replyTo: Type.Optional(collaborationObligationIdSchema),
        obligationId: Type.Optional(collaborationObligationIdSchema),
        metadata: Type.Optional(collaborationMetadataSchema),
        createdAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
    },
    { additionalProperties: false },
);

export const collaborationObligationStatusSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("answered"),
    Type.Literal("cancelled"),
]);

/** A directed answer obligation. The requester is the only agent allowed to wait. */
const collaborationObligationCommonProperties = {
    id: collaborationObligationIdSchema,
    requesterAgentId: collaborationAgentIdSchema,
    responderAgentId: collaborationAgentIdSchema,
    messageId: collaborationMessageIdSchema,
    createdAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
    updatedAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
};

export const collaborationObligationSchema = Type.Union([
    Type.Object(
        {
            ...collaborationObligationCommonProperties,
            status: Type.Literal("pending"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...collaborationObligationCommonProperties,
            status: Type.Literal("answered"),
            answerMessageId: collaborationMessageIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...collaborationObligationCommonProperties,
            status: Type.Literal("cancelled"),
        },
        { additionalProperties: false },
    ),
]);

export const collaborationObligationPageQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        status: Type.Optional(collaborationObligationStatusSchema),
        requesterAgentId: Type.Optional(collaborationAgentIdSchema),
        responderAgentId: Type.Optional(collaborationAgentIdSchema),
    },
    { additionalProperties: false },
);

export const collaborationObligationPageSchema = Type.Object(
    {
        obligations: Type.Array(collaborationObligationSchema, { maxItems: 100 }),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);

const collaborationSendCommonProperties = {
    toAgentId: collaborationAgentIdSchema,
    text: collaborationMessageTextSchema,
    messageId: Type.Optional(collaborationMessageIdSchema),
    metadata: Type.Optional(collaborationMetadataSchema),
    /** True runs the target in Read only; false restores the sender's current mode. */
    readOnly: Type.Optional(Type.Boolean()),
};

/**
 * A send either starts a reply obligation or is a plain message. Replies have their own public
 * input so callers cannot accidentally answer an unrelated obligation.
 */
export const collaborationSendInputSchema = Type.Union([
    Type.Object(
        {
            ...collaborationSendCommonProperties,
            expectReply: Type.Literal(true),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...collaborationSendCommonProperties,
            expectReply: Type.Optional(Type.Literal(false)),
        },
        { additionalProperties: false },
    ),
]);

/** Model input omits the module-owned message identity. */
export const collaborationSendToolInputSchema = Type.Union([
    Type.Object(
        {
            toAgentId: collaborationAgentIdSchema,
            text: collaborationMessageTextSchema,
            metadata: Type.Optional(collaborationMetadataSchema),
            readOnly: Type.Optional(Type.Boolean()),
            expectReply: Type.Literal(true),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            toAgentId: collaborationAgentIdSchema,
            text: collaborationMessageTextSchema,
            metadata: Type.Optional(collaborationMetadataSchema),
            readOnly: Type.Optional(Type.Boolean()),
            expectReply: Type.Optional(Type.Literal(false)),
        },
        { additionalProperties: false },
    ),
]);

export const collaborationReplyInputSchema = Type.Object(
    {
        toAgentId: collaborationAgentIdSchema,
        text: collaborationMessageTextSchema,
        messageId: Type.Optional(collaborationMessageIdSchema),
        metadata: Type.Optional(collaborationMetadataSchema),
        /** True runs the target in Read only; false restores the sender's current mode. */
        readOnly: Type.Optional(Type.Boolean()),
        replyTo: collaborationObligationIdSchema,
    },
    { additionalProperties: false },
);

/** Model input omits the module-owned message identity. */
export const collaborationReplyToolInputSchema = Type.Omit(collaborationReplyInputSchema, [
    "messageId",
]);

export const collaborationWaitInputSchema = Type.Object(
    {
        obligationId: collaborationObligationIdSchema,
    },
    { additionalProperties: false },
);

/** Wait for a collaborator's run to change state and return its bounded final/current output. */
export const collaborationWaitForAgentInputSchema = Type.Object(
    {
        agentId: collaborationAgentIdSchema,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
    },
    { additionalProperties: false },
);

/** Model input may wait on a directed reply or on a collaborator's run. */
export const collaborationWaitToolInputSchema = Type.Union([
    collaborationWaitInputSchema,
    collaborationWaitForAgentInputSchema,
]);

/** The two result families exposed by wait_for_reply. */
export const collaborationWaitResultSchema = Type.Union([
    collaborationObligationSchema,
    collaborationAgentObservationSchema,
]);

export const collaborationSendResultSchema = Type.Object(
    {
        message: collaborationMessageSchema,
        obligation: Type.Optional(collaborationObligationSchema),
    },
    { additionalProperties: false },
);

export type CollaborationMessageId = Static<typeof collaborationMessageIdSchema>;
export type CollaborationObligationId = Static<typeof collaborationObligationIdSchema>;
export type CollaborationMessage = Static<typeof collaborationMessageSchema>;
export type CollaborationObligationStatus = Static<typeof collaborationObligationStatusSchema>;
export type CollaborationObligation = Static<typeof collaborationObligationSchema>;
export type CollaborationObligationPageQuery = Static<
    typeof collaborationObligationPageQuerySchema
>;
export type CollaborationObligationPage = Static<typeof collaborationObligationPageSchema>;
export type CollaborationSendInput = Static<typeof collaborationSendInputSchema>;
export type CollaborationSendToolInput = Static<typeof collaborationSendToolInputSchema>;
export type CollaborationReplyInput = Static<typeof collaborationReplyInputSchema>;
export type CollaborationReplyToolInput = Static<typeof collaborationReplyToolInputSchema>;
export type CollaborationWaitInput = Static<typeof collaborationWaitInputSchema>;
export type CollaborationWaitForAgentInput = Static<typeof collaborationWaitForAgentInputSchema>;
export type CollaborationWaitToolInput = Static<typeof collaborationWaitToolInputSchema>;
export type CollaborationWaitResult = Static<typeof collaborationWaitResultSchema>;
export type CollaborationSendResult = Static<typeof collaborationSendResultSchema>;
