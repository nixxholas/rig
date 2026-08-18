import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_WORKSPACE_EVENT_ID_LENGTH,
    workspaceAgentIdSchema,
    workspaceIdSchema,
    workspaceNameSchema,
    workspaceOrderKeySchema,
    workspaceProjectRefSchema,
    workspaceSchema,
    workspaceTimestampSchema,
} from "./Workspace.js";

/** Context is host-owned and opaque to this module. */
export const workspaceContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

export const workspaceEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_EVENT_ID_LENGTH,
});

/**
 * The lifecycle step behind a `workspace_updated` event. These transitions are host bookkeeping —
 * Git discovery, readiness, failure, and the start of archival — rather than something a person
 * asked for by name, so they share one event and say which step they were.
 */
export const workspaceUpdateChangeSchema = Type.Union([
    Type.Literal("record_initialization"),
    Type.Literal("mark_ready"),
    Type.Literal("mark_failed"),
    Type.Literal("mark_initialization_failed"),
    Type.Literal("set_branch"),
    Type.Literal("begin_archive"),
    Type.Literal("apply_git_facts"),
    Type.Literal("apply_probe"),
]);

const eventEnvelope = {
    eventId: workspaceEventIdSchema,
    at: workspaceTimestampSchema,
} as const;

export const workspaceEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_created"),
            workspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_updated"),
            change: workspaceUpdateChangeSchema,
            workspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_transferred"),
            workspace: workspaceSchema,
            previousProjectRef: Type.Optional(workspaceProjectRefSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_renamed"),
            workspace: workspaceSchema,
            previousName: workspaceNameSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_reordered"),
            workspace: workspaceSchema,
            previousOrderKey: workspaceOrderKeySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_archived"),
            workspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_transfer_scheduled"),
            targetWorkspaceId: workspaceIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export type WorkspaceUpdateChange = Static<typeof workspaceUpdateChangeSchema>;
export type WorkspaceEvent = Static<typeof workspaceEventSchema>;

const workspaceListenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

/**
 * Both observers receive the exact same detached, deeply frozen event object.
 * The host calls the post-commit callback only once its outermost transaction
 * has committed.
 */
export const workspaceModuleListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function(
                [workspaceContextSchema, workspaceEventSchema],
                workspaceListenerResultSchema,
            ),
        ),
        onEvent: Type.Optional(
            Type.Function(
                [workspaceContextSchema, workspaceEventSchema],
                workspaceListenerResultSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkspaceModuleListener = Static<typeof workspaceModuleListenerSchema>;
