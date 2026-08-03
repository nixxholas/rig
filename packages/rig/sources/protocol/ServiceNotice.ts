import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });

export const SERVICE_NOTICE_MESSAGE_MAX_LENGTH = 4_096;
export const SERVICE_NOTICE_TEXT_MAX_LENGTH = 8_192;

export const computePreparationNoticeSchema = Type.Object(
    {
        computeInstanceId: nonEmptyText,
        elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
        kind: Type.Literal("compute_preparation"),
        message: Type.String({ maxLength: SERVICE_NOTICE_MESSAGE_MAX_LENGTH, minLength: 1 }),
        percent: Type.Optional(Type.Number({ maximum: 100, minimum: 0 })),
        phase: Type.String({ maxLength: 128, minLength: 1 }),
        provider: nonEmptyText,
        state: Type.Union([
            Type.Literal("failed"),
            Type.Literal("provisioning"),
            Type.Literal("ready"),
            Type.Literal("stopped"),
            Type.Literal("unprovisioned"),
        ]),
    },
    exact,
);
export type ComputePreparationNotice = Static<typeof computePreparationNoticeSchema>;

export const serviceNoticeSchema = Type.Union([computePreparationNoticeSchema]);
export type ServiceNotice = Static<typeof serviceNoticeSchema>;

/**
 * A service-style transcript row.
 *
 * `text` is required so clients that do not understand `structured.kind` still have a complete,
 * human-readable message to render.
 */
export const systemNoticePayloadSchema = Type.Object(
    {
        structured: Type.Optional(serviceNoticeSchema),
        text: Type.String({ maxLength: SERVICE_NOTICE_TEXT_MAX_LENGTH, minLength: 1 }),
    },
    exact,
);
export type SystemNoticePayload = Static<typeof systemNoticePayloadSchema>;
