import { agentPermissionModeSchema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

const permissionContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);
const permissionAgentIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const permissionCallIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const permissionToolSchema = Type.String({ minLength: 1, maxLength: 256 });
const permissionActionSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const permissionReasonSchema = Type.String({ minLength: 1, maxLength: 4_096 });

/** Everything that happened to one agent's permissions, as the module saw it. */
export const permissionEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("permission_mode_changed"),
            agentId: permissionAgentIdSchema,
            previousMode: agentPermissionModeSchema,
            mode: agentPermissionModeSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("permission_mode_cleanup_failed"),
            agentId: permissionAgentIdSchema,
            previousMode: agentPermissionModeSchema,
            mode: agentPermissionModeSchema,
            reason: permissionReasonSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("permission_action_reviewed"),
            agentId: permissionAgentIdSchema,
            callId: permissionCallIdSchema,
            tool: permissionToolSchema,
            action: permissionActionSchema,
            elevated: Type.Boolean(),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("permission_action_denied"),
            agentId: permissionAgentIdSchema,
            callId: permissionCallIdSchema,
            tool: permissionToolSchema,
            action: permissionActionSchema,
            reason: permissionReasonSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("permission_action_unproven"),
            agentId: permissionAgentIdSchema,
            callId: permissionCallIdSchema,
            tool: permissionToolSchema,
            action: permissionActionSchema,
            reason: permissionReasonSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("permission_action_out_of_mode"),
            agentId: permissionAgentIdSchema,
            callId: permissionCallIdSchema,
            tool: permissionToolSchema,
            mode: agentPermissionModeSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("permission_turn_stopped"),
            agentId: permissionAgentIdSchema,
            refusals: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
    ),
]);

export type PermissionEvent = Static<typeof permissionEventSchema>;

/** Runtime contract for the host listener supplied to the module. */
export const permissionModuleListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function(
                [permissionContextSchema, permissionEventSchema],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
        onEvent: Type.Optional(
            Type.Function([permissionContextSchema, permissionEventSchema], Type.Void()),
        ),
    },
    { additionalProperties: false },
);

/**
 * Whoever the permissions module reports to. Both callbacks see the same events; what differs is
 * when.
 *
 * `onEventTransactional` runs inside the transaction that commits the change it describes, which
 * only a mode change has: a listener writing a record of its own commits it with the change, and
 * its failure rolls both back. `onEvent` runs once the change is durable, and every decision about
 * a single tool call — which commits nothing — is reported only there.
 */
export type PermissionModuleListener = Static<typeof permissionModuleListenerSchema>;
