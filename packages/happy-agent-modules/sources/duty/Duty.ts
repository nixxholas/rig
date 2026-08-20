import { Type, type Static } from "@sinclair/typebox";

import { agentPermissionModeSchema } from "@slopus/happy-agent-base";

export const MAX_DUTY_AGENT_ID_LENGTH = 256;
export const MAX_DUTY_ID_LENGTH = 128;
export const MAX_DUTY_CHARTER_CHARACTERS = 20_000;
export const MAX_DUTY_TRIGGER_CHARACTERS = 8_000;
export const MAX_DUTY_TOOL_NAME_LENGTH = 128;
export const MAX_DUTY_ALLOWED_TOOLS = 256;

export const dutyAgentIdSchema = Type.String({ minLength: 1, maxLength: MAX_DUTY_AGENT_ID_LENGTH });
export const dutyIdSchema = Type.String({ minLength: 1, maxLength: MAX_DUTY_ID_LENGTH });
export const dutyTimestampSchema = Type.Integer({ minimum: 0 });
export const dutyCharterSchema = Type.String({
    minLength: 1,
    maxLength: MAX_DUTY_CHARTER_CHARACTERS,
});
export const dutyTriggerSchema = Type.String({
    minLength: 1,
    maxLength: MAX_DUTY_TRIGGER_CHARACTERS,
});
export const dutyToolNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_DUTY_TOOL_NAME_LENGTH,
    pattern: "^\\S+$",
});
export const dutyAllowedToolsSchema = Type.Array(dutyToolNameSchema, {
    maxItems: MAX_DUTY_ALLOWED_TOOLS,
    uniqueItems: true,
});

export const dutyStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("paused"),
    Type.Literal("stopped"),
]);

export const dutyBindingSchema = Type.Object(
    {
        agentId: dutyAgentIdSchema,
        allowedTools: dutyAllowedToolsSchema,
        charter: dutyCharterSchema,
        createdAt: dutyTimestampSchema,
        dutyId: dutyIdSchema,
        permissionCeiling: agentPermissionModeSchema,
        status: dutyStatusSchema,
        tenureId: dutyIdSchema,
        updatedAt: dutyTimestampSchema,
    },
    { additionalProperties: false },
);

export const dutyRunStatusSchema = Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
]);

export const dutyRunSchema = Type.Object(
    {
        agentId: dutyAgentIdSchema,
        createdAt: dutyTimestampSchema,
        dutyId: dutyIdSchema,
        error: Type.Optional(Type.String({ maxLength: MAX_DUTY_TRIGGER_CHARACTERS })),
        runId: dutyIdSchema,
        settledAt: Type.Optional(dutyTimestampSchema),
        startedAt: Type.Optional(dutyTimestampSchema),
        status: dutyRunStatusSchema,
        tenureId: dutyIdSchema,
        trigger: dutyTriggerSchema,
    },
    { additionalProperties: false },
);

export const issueDutyInputSchema = Type.Object(
    {
        allowedTools: dutyAllowedToolsSchema,
        charter: dutyCharterSchema,
        dutyId: dutyIdSchema,
        permissionCeiling: agentPermissionModeSchema,
        tenureId: dutyIdSchema,
        trigger: dutyTriggerSchema,
    },
    { additionalProperties: false },
);

export type DutyBinding = Static<typeof dutyBindingSchema>;
export type DutyRun = Static<typeof dutyRunSchema>;
export type DutyStatus = Static<typeof dutyStatusSchema>;
export type IssueDutyInput = Static<typeof issueDutyInputSchema>;
