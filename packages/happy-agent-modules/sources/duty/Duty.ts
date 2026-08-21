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

/**
 * A Duty's own wake interval, in milliseconds.
 *
 * The floor keeps a misdeclared roster from spending a model call every second. The ceiling matches
 * the scheduling module's horizon, because a Duty re-arms from its stored `nextWakeAt` on every
 * start rather than holding one long alarm a restart would drop.
 */
export const MIN_DUTY_INTERVAL_MS = 60_000;
export const MAX_DUTY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const dutyIntervalSchema = Type.Integer({
    minimum: MIN_DUTY_INTERVAL_MS,
    maximum: MAX_DUTY_INTERVAL_MS,
});

export const dutyRosterAuthoritySchema = Type.Object(
    {
        declarationHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        project: Type.String({ minLength: 1, maxLength: 4_096 }),
    },
    { additionalProperties: false },
);

export const dutyBindingSchema = Type.Object(
    {
        agentId: dutyAgentIdSchema,
        allowedTools: dutyAllowedToolsSchema,
        charter: dutyCharterSchema,
        createdAt: dutyTimestampSchema,
        dutyId: dutyIdSchema,
        /** How often this Duty wakes itself; absent when it only runs when something asks it to. */
        every: Type.Optional(dutyIntervalSchema),
        /** When its next periodic run is due; absent when the Duty has no interval. */
        nextWakeAt: Type.Optional(dutyTimestampSchema),
        permissionCeiling: agentPermissionModeSchema,
        /** Present only when this binding is owned by the local machine roster. */
        roster: Type.Optional(dutyRosterAuthoritySchema),
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
        every: Type.Optional(dutyIntervalSchema),
        permissionCeiling: agentPermissionModeSchema,
        tenureId: dutyIdSchema,
        trigger: dutyTriggerSchema,
    },
    { additionalProperties: false },
);

/**
 * One `[[duty]]` entry from the machine's Duty roster.
 *
 * A declaration names the project the Duty works in rather than an agent, because an agent is an
 * implementation detail the roster should not have to know: the reconciler binds one durable agent
 * per Duty and keeps that binding across restarts.
 */
export const dutyDeclarationSchema = Type.Object(
    {
        allowedTools: dutyAllowedToolsSchema,
        charter: dutyCharterSchema,
        dutyId: dutyIdSchema,
        every: Type.Optional(dutyIntervalSchema),
        permissionCeiling: agentPermissionModeSchema,
        project: Type.String({ minLength: 1, maxLength: 4_096 }),
        tenureId: dutyIdSchema,
        trigger: dutyTriggerSchema,
    },
    { additionalProperties: false },
);

export const dutyReconcileOptionsSchema = Type.Object(
    { authoritative: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
);

export const dutyReconciliationSchema = Type.Object(
    {
        issued: Type.Array(dutyIdSchema),
        notices: Type.Array(Type.String()),
        stopped: Type.Array(dutyIdSchema),
        unchanged: Type.Array(dutyIdSchema),
        updated: Type.Array(dutyIdSchema),
    },
    { additionalProperties: false },
);

export type DutyBinding = Static<typeof dutyBindingSchema>;
export type DutyDeclaration = Static<typeof dutyDeclarationSchema>;
export type DutyRun = Static<typeof dutyRunSchema>;
export type DutyRosterAuthority = Static<typeof dutyRosterAuthoritySchema>;
export type DutyStatus = Static<typeof dutyStatusSchema>;
export type IssueDutyInput = Static<typeof issueDutyInputSchema>;
export type DutyReconciliation = Static<typeof dutyReconciliationSchema>;
export type DutyReconcileOptions = Static<typeof dutyReconcileOptionsSchema>;
