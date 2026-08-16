import type { AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

const MAX_PERMISSION_AGENT_ID = 128;
const MAX_PERMISSION_CALL_ID = 256;
const MAX_PERMISSION_ACTION = 16_384;
const MAX_PERMISSION_REASON = 4_096;
const MAX_PERMISSION_ARGUMENT_STRING = 8_192;
const MAX_PERMISSION_ARGUMENT_ITEMS = 256;
const MAX_PERMISSION_ARGUMENT_DEPTH = 8;
const MAX_PERMISSION_ARGUMENT_BYTES = 65_536;

const permissionContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);
const permissionAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PERMISSION_AGENT_ID,
});
const permissionCallIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PERMISSION_CALL_ID,
});
const permissionToolSchema = Type.Unsafe<AnyAgentTool>(
    Type.Object(
        {
            name: Type.String({ minLength: 1, maxLength: 256 }),
            namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        },
        { additionalProperties: true },
    ),
);
const permissionAbortSignalSchema = Type.Unsafe<AbortSignal>(
    Type.Object(
        {
            aborted: Type.Boolean(),
            addEventListener: Type.Function([], Type.Any()),
        },
        { additionalProperties: true },
    ),
);

function permissionReviewArgumentSchema(depth: number): TSchema {
    const scalar = Type.Union([
        Type.Undefined(),
        Type.Null(),
        Type.Boolean(),
        Type.Number(),
        Type.String({ maxLength: MAX_PERMISSION_ARGUMENT_STRING }),
    ]);
    if (depth === 0) return scalar;
    const child = permissionReviewArgumentSchema(depth - 1);
    return Type.Union([
        scalar,
        Type.Array(child, { maxItems: MAX_PERMISSION_ARGUMENT_ITEMS }),
        Type.Record(Type.String({ maxLength: 256 }), child, {
            maxProperties: MAX_PERMISSION_ARGUMENT_ITEMS,
        }),
    ]);
}

export const permissionReviewArgumentsSchema = permissionReviewArgumentSchema(
    MAX_PERMISSION_ARGUMENT_DEPTH,
);

export const permissionRiskSchema = Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
]);

export const permissionUserAuthorizationSchema = Type.Union([
    Type.Literal("unknown"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
]);

export const permissionReviewRequestSchema = Type.Object(
    {
        agentId: permissionAgentIdSchema,
        callId: permissionCallIdSchema,
        tool: permissionToolSchema,
        arguments: permissionReviewArgumentsSchema,
        action: Type.String({ minLength: 1, maxLength: MAX_PERMISSION_ACTION }),
        mode: Type.Literal("auto"),
        elevates: Type.Boolean(),
        signal: permissionAbortSignalSchema,
    },
    { additionalProperties: false },
);

const allowedPermissionReviewDecisionSchema = Type.Object(
    {
        outcome: Type.Literal("allowed"),
        reason: Type.Optional(Type.String({ maxLength: MAX_PERMISSION_REASON })),
        risk: permissionRiskSchema,
        userAuthorization: permissionUserAuthorizationSchema,
    },
    { additionalProperties: false },
);

const deniedPermissionReviewDecisionSchema = Type.Object(
    {
        outcome: Type.Literal("denied"),
        reason: Type.String({ minLength: 1, maxLength: MAX_PERMISSION_REASON }),
        risk: Type.Optional(permissionRiskSchema),
        userAuthorization: Type.Optional(permissionUserAuthorizationSchema),
    },
    { additionalProperties: false },
);

/**
 * The reviewer must return the risk and authorization it relied on. Permissions applies its own
 * policy to an allowed result: critical actions never pass, and high-risk actions require at
 * least medium user authorization.
 */
export const permissionReviewDecisionSchema = Type.Union([
    allowedPermissionReviewDecisionSchema,
    deniedPermissionReviewDecisionSchema,
]);

export type PermissionReviewRequest = Static<typeof permissionReviewRequestSchema>;
export type PermissionReviewDecision = Static<typeof permissionReviewDecisionSchema>;

export const permissionReviewerSchema = Type.Object(
    {
        review: Type.Function(
            [permissionContextSchema, permissionReviewRequestSchema],
            Type.Promise(permissionReviewDecisionSchema),
        ),
    },
    { additionalProperties: true },
);

/**
 * Whoever decides, on the user's behalf, whether one Auto action may go ahead. Review is
 * automatic: it must never become a question put to the person, and it must answer in bounded
 * time.
 */
export type PermissionReviewer = Static<typeof permissionReviewerSchema>;

export {
    MAX_PERMISSION_ACTION,
    MAX_PERMISSION_ARGUMENT_BYTES,
    MAX_PERMISSION_ARGUMENT_DEPTH,
    MAX_PERMISSION_ARGUMENT_ITEMS,
    MAX_PERMISSION_ARGUMENT_STRING,
    MAX_PERMISSION_AGENT_ID,
    MAX_PERMISSION_CALL_ID,
    MAX_PERMISSION_REASON,
};
