import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    workletAgentIdSchema,
    workletNameSchema,
    workletSchema,
    workletTimestampSchema,
    workletVersionNumberSchema,
} from "./Worklet.js";

export const MAX_WORKLET_EVENT_ID_LENGTH = 256;

export const workletEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKLET_EVENT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const opaqueContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

const eventEnvelope = {
    eventId: workletEventIdSchema,
    at: workletTimestampSchema,
    agentId: workletAgentIdSchema,
};

/** Stable events delivered transactionally and after the host's outermost commit. */
export const workletEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("worklet_installed"),
            worklet: workletSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("worklet_updated"),
            worklet: workletSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("worklet_reverted"),
            worklet: workletSchema,
            previousVersion: workletVersionNumberSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("worklet_removed"),
            name: workletNameSchema,
            ownerAgentId: workletAgentIdSchema,
            previousVersion: workletVersionNumberSchema,
        },
        { additionalProperties: false },
    ),
]);

export type WorkletEvent = Static<typeof workletEventSchema>;

export const workletFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function(
                [opaqueContextSchema, workletEventSchema],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
        onEvent: Type.Optional(
            Type.Function(
                [opaqueContextSchema, workletEventSchema],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkletFeatureListener = Static<typeof workletFeatureListenerSchema>;