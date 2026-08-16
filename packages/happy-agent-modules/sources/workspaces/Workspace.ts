import { Type, type Static } from "@sinclair/typebox";

/**
 * Workspaces are module-owned records. The module stores opaque references and
 * forwards an optional host-reported path without interpreting filesystem,
 * branch, or Git values.
 */
export const MAX_WORKSPACE_ID_LENGTH = 96;
export const MAX_WORKSPACE_AGENT_ID_LENGTH = 96;
export const MAX_WORKSPACE_OPERATION_ID_LENGTH = 96;
export const MAX_WORKSPACE_PROJECT_REF_LENGTH = 256;
export const MAX_WORKSPACE_NAME_LENGTH = 500;
export const MAX_WORKSPACE_BASE_REF_LENGTH = 1_024;
export const MAX_WORKSPACE_PATH_LENGTH = 4_096;
export const MAX_WORKSPACE_EVENT_ID_LENGTH = 128;
export const MAX_WORKSPACE_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export const workspaceIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_ID_LENGTH,
});

export const workspaceAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_AGENT_ID_LENGTH,
});

export const workspaceOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_OPERATION_ID_LENGTH,
});

/** An opaque host-owned reference to a project. */
export const workspaceProjectRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_PROJECT_REF_LENGTH,
});

export const workspaceNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_NAME_LENGTH,
});

export const workspaceBaseRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_BASE_REF_LENGTH,
});

/** An optional host-owned filesystem location for this workspace. */
export const workspacePathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_PATH_LENGTH,
});

export const workspaceStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("active"),
    Type.Literal("failed"),
    Type.Literal("archiving"),
    Type.Literal("archived"),
]);

export const workspaceTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKSPACE_TIMESTAMP,
});

export const workspaceMutationOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("rename"),
    Type.Literal("transfer"),
    Type.Literal("archive"),
]);

/**
 * Public workspace data. `ownerAgentId` is deliberately part of the record:
 * the module cannot enforce exact ownership if a host can omit it.
 */
export const workspaceSchema = Type.Object(
    {
        id: workspaceIdSchema,
        ownerAgentId: workspaceAgentIdSchema,
        projectRef: workspaceProjectRefSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
        path: Type.Optional(workspacePathSchema),
        name: workspaceNameSchema,
        status: workspaceStatusSchema,
        createdAt: workspaceTimestampSchema,
        updatedAt: workspaceTimestampSchema,
        archivedAt: Type.Optional(workspaceTimestampSchema),
    },
    { additionalProperties: false },
);

/**
 * Public creation input. Durable tools pass their stable call ID as
 * `operationId`; direct callers may provide one or let the module allocate it.
 */
export const workspaceCreateInputSchema = Type.Object(
    {
        id: Type.Optional(workspaceIdSchema),
        operationId: Type.Optional(workspaceOperationIdSchema),
        projectRef: Type.Optional(workspaceProjectRefSchema),
        path: Type.Optional(workspacePathSchema),
        name: workspaceNameSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
    },
    { additionalProperties: false },
);

/** Input exposed to the model; persistence identities remain module-owned. */
export const workspaceCreateToolInputSchema = Type.Object(
    {
        projectRef: Type.Optional(workspaceProjectRefSchema),
        name: workspaceNameSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
    },
    { additionalProperties: false },
);

export const workspaceArchiveOptionsSchema = Type.Object(
    {
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceRenameInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
        expectedUpdatedAt: Type.Optional(workspaceTimestampSchema),
        operationId: Type.Optional(workspaceOperationIdSchema),
    },
    { additionalProperties: false },
);

/** Positional rename changes for hosts that already hold the workspace ID. */
export const workspaceRenameChangesSchema = Type.Object(
    {
        name: workspaceNameSchema,
        expectedUpdatedAt: Type.Optional(workspaceTimestampSchema),
    },
    { additionalProperties: false },
);

/** Input exposed to the model; mutation identities remain module-owned. */
export const workspaceRenameToolInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
    },
    { additionalProperties: false },
);

export type WorkspaceId = Static<typeof workspaceIdSchema>;
export type WorkspaceAgentId = Static<typeof workspaceAgentIdSchema>;
export type WorkspaceOperationId = Static<typeof workspaceOperationIdSchema>;
export type WorkspaceProjectRef = Static<typeof workspaceProjectRefSchema>;
export type WorkspaceName = Static<typeof workspaceNameSchema>;
export type WorkspaceBaseRef = Static<typeof workspaceBaseRefSchema>;
export type WorkspacePath = Static<typeof workspacePathSchema>;
export type WorkspaceStatus = Static<typeof workspaceStatusSchema>;
export type WorkspaceMutationOperation = Static<typeof workspaceMutationOperationSchema>;
export type Workspace = Static<typeof workspaceSchema>;
export type WorkspaceCreateInput = Static<typeof workspaceCreateInputSchema>;
export type WorkspaceCreateToolInput = Static<typeof workspaceCreateToolInputSchema>;
export type WorkspaceArchiveOptions = Static<typeof workspaceArchiveOptionsSchema>;
export type WorkspaceRenameInput = Static<typeof workspaceRenameInputSchema>;
export type WorkspaceRenameChanges = Static<typeof workspaceRenameChangesSchema>;
export type WorkspaceRenameToolInput = Static<typeof workspaceRenameToolInputSchema>;
