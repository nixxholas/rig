import { Type, type Static } from "@sinclair/typebox";
import { agentConfigSchema } from "@slopus/happy-agent-base";

/** The largest timestamp accepted by collaboration persistence. */
export const COLLABORATION_MAX_TIMESTAMP = 8_640_000_000_000_000;

/** IDs used by the collaboration roster and by Agent Base. */
export const collaborationAgentIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});

/** Limits apply at every metadata level, and the encoded limit is checked semantically. */
export const COLLABORATION_METADATA_MAX_DEPTH = 8;
export const COLLABORATION_METADATA_MAX_STRING_LENGTH = 4_096;
export const COLLABORATION_METADATA_MAX_KEY_LENGTH = 128;
export const COLLABORATION_METADATA_MAX_ITEMS = 64;
export const COLLABORATION_METADATA_MAX_PROPERTIES = 64;
export const COLLABORATION_METADATA_MAX_ENCODED_BYTES = 16_384;

/** A JSON value accepted in agent, message, and protocol metadata. */
export const collaborationMetadataValueSchema = Type.Recursive((value) =>
    Type.Union([
        Type.String({ maxLength: COLLABORATION_METADATA_MAX_STRING_LENGTH }),
        Type.Number(),
        Type.Boolean(),
        Type.Null(),
        Type.Array(value, { maxItems: COLLABORATION_METADATA_MAX_ITEMS }),
        Type.Record(Type.String({ maxLength: COLLABORATION_METADATA_MAX_KEY_LENGTH }), value, {
            maxProperties: COLLABORATION_METADATA_MAX_PROPERTIES,
        }),
    ]),
);

export const collaborationMetadataSchema = Type.Record(
    Type.String({ maxLength: COLLABORATION_METADATA_MAX_KEY_LENGTH }),
    collaborationMetadataValueSchema,
    { maxProperties: COLLABORATION_METADATA_MAX_PROPERTIES },
);

/** A small, host-defined role for an agent in a collaboration. */
export const collaborationRoleSchema = Type.String({
    minLength: 1,
    maxLength: 128,
});

/** The effort values supported by Agent Base provider sessions. */
export const collaborationEffortSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
    Type.Literal("ultra"),
]);

/** The service-tier override supported by Agent Base provider sessions. */
export const collaborationServiceTierSchema = Type.Literal("priority");

/** The two context sources a collaborator may start with. */
export const collaborationContextModeSchema = Type.Union([
    Type.Literal("parent"),
    Type.Literal("task"),
]);

/**
 * Codex's fork-turns spelling is kept as a provider-neutral value. `none` starts a task context,
 * `all` forks the whole parent context, and a positive integer forks that many recent turns.
 */
export const collaborationForkTurnsSchema = Type.Union([
    Type.Literal("none"),
    Type.Literal("all"),
    Type.String({ pattern: "^[1-9][0-9]{0,3}$", maxLength: 4 }),
]);

/** Stable identity of one collaborator run, supplied by the host broker. */
export const collaborationRunIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
});

/** Monotonic broker version used to reject delayed observations. */
export const collaborationRunVersionSchema = Type.Integer({
    minimum: 0,
    maximum: 1_000_000_000,
});

/** A provider/model route supplied by the host's curated catalog. */
export const collaborationAvailableModelSchema = Type.Object(
    {
        defaultEffort: collaborationEffortSchema,
        effortLevels: Type.Array(collaborationEffortSchema, { minItems: 1, maxItems: 8 }),
        id: Type.String({ minLength: 1, maxLength: 256 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTiers: Type.Optional(
            Type.Array(collaborationServiceTierSchema, { minItems: 1, maxItems: 1 }),
        ),
    },
    { additionalProperties: false },
);

export const collaborationDisabledProviderReasonSchema = Type.Union([
    Type.Literal("not_authenticated"),
    Type.Literal("not_enabled"),
    Type.Literal("no_models"),
]);

export const collaborationDisabledProviderSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 256 }),
        reason: collaborationDisabledProviderReasonSchema,
    },
    { additionalProperties: false },
);

/** Curated model/provider data owned by the host, not by Collaboration. */
export const collaborationModelCatalogSchema = Type.Object(
    {
        availableModels: Type.Array(collaborationAvailableModelSchema, {
            maxItems: 256,
        }),
        disabledProviders: Type.Array(collaborationDisabledProviderSchema, {
            maxItems: 256,
        }),
    },
    { additionalProperties: false },
);

/** The settings requested for a newly created collaborator. */
export const collaborationAgentSelectionSchema = Type.Object(
    {
        model: Type.String({ minLength: 1, maxLength: 256 }),
        effort: collaborationEffortSchema,
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(collaborationServiceTierSchema),
    },
    { additionalProperties: false },
);

/** The host's bounded view of active collaborator capacity. */
export const collaborationSpawnCapacitySchema = Type.Object(
    {
        canSpawn: Type.Boolean(),
        depth: Type.Integer({ minimum: 0, maximum: 1_000 }),
        maxDepth: Type.Integer({ minimum: 0, maximum: 1_000 }),
        maxActive: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
        active: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    },
    { additionalProperties: false },
);

/** Durable lifecycle state owned by the host roster. Agents are never deleted by this module. */
export const collaborationAgentStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("idle"),
    Type.Literal("waiting"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("error"),
    Type.Literal("aborted"),
    Type.Literal("suspended"),
]);

/** A bounded observation of a collaborator's current or terminal run. */
export const collaborationAgentObservationSchema = Type.Object(
    {
        agentId: collaborationAgentIdSchema,
        runId: collaborationRunIdSchema,
        version: collaborationRunVersionSchema,
        status: collaborationAgentStatusSchema,
        output: Type.Optional(Type.String({ maxLength: 50_000 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        updatedAt: Type.Optional(
            Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        ),
    },
    { additionalProperties: false },
);

/**
 * Durable host-owned roster row for one Agent Base identity.
 *
 * `ownerAgentId` is the caller that created or controls the row. A root row owns itself;
 * descendants normally use their creating agent as owner. A host authorization policy may grant
 * additional access without changing this durable ownership.
 */
export const collaborationAgentSchema = Type.Object(
    {
        id: collaborationAgentIdSchema,
        ownerAgentId: collaborationAgentIdSchema,
        parentId: Type.Union([collaborationAgentIdSchema, Type.Null()]),
        role: Type.Optional(collaborationRoleSchema),
        groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        metadata: Type.Optional(collaborationMetadataSchema),
        status: collaborationAgentStatusSchema,
        runId: Type.Optional(collaborationRunIdSchema),
        runVersion: collaborationRunVersionSchema,
        observationUpdatedAt: Type.Optional(
            Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        ),
        createdAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        updatedAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
    },
    { additionalProperties: false },
);

/** Input for host or tool-created collaborators. The module assigns omitted IDs. */
export const collaborationCreateInputSchema = Type.Object(
    {
        id: Type.Optional(collaborationAgentIdSchema),
        config: agentConfigSchema,
        model: Type.String({ minLength: 1, maxLength: 256 }),
        effort: collaborationEffortSchema,
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(collaborationServiceTierSchema),
        context: Type.Optional(collaborationContextModeSchema),
        forkTurns: Type.Optional(collaborationForkTurnsSchema),
        readOnly: Type.Optional(Type.Boolean()),
        parentId: Type.Optional(Type.Union([collaborationAgentIdSchema, Type.Null()])),
        role: Type.Optional(collaborationRoleSchema),
        groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        metadata: Type.Optional(collaborationMetadataSchema),
    },
    { additionalProperties: false },
);

/** Input exposed to the model; durable roster and Agent Base identities are module-owned. */
export const collaborationCreateToolInputSchema = Type.Omit(collaborationCreateInputSchema, ["id"]);

/** A bounded roster query. Cursors are opaque to the module and host. */
export const collaborationAgentPageQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        ownerAgentId: Type.Optional(collaborationAgentIdSchema),
    },
    { additionalProperties: false },
);

export const collaborationAgentPageSchema = Type.Object(
    {
        agents: Type.Array(collaborationAgentSchema, { maxItems: 100 }),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);

export type CollaborationAgentId = Static<typeof collaborationAgentIdSchema>;
export type CollaborationRole = Static<typeof collaborationRoleSchema>;
export type CollaborationEffort = Static<typeof collaborationEffortSchema>;
export type CollaborationServiceTier = Static<typeof collaborationServiceTierSchema>;
export type CollaborationContextMode = Static<typeof collaborationContextModeSchema>;
export type CollaborationForkTurns = Static<typeof collaborationForkTurnsSchema>;
export type CollaborationRunId = Static<typeof collaborationRunIdSchema>;
export type CollaborationRunVersion = Static<typeof collaborationRunVersionSchema>;
export type CollaborationAvailableModel = Static<typeof collaborationAvailableModelSchema>;
export type CollaborationDisabledProvider = Static<typeof collaborationDisabledProviderSchema>;
export type CollaborationModelCatalog = Static<typeof collaborationModelCatalogSchema>;
export type CollaborationAgentSelection = Static<typeof collaborationAgentSelectionSchema>;
export type CollaborationSpawnCapacity = Static<typeof collaborationSpawnCapacitySchema>;
export type CollaborationAgentObservation = Static<typeof collaborationAgentObservationSchema>;
export type CollaborationAgentStatus = Static<typeof collaborationAgentStatusSchema>;
export type CollaborationMetadataValue = Static<typeof collaborationMetadataValueSchema>;
export type CollaborationMetadata = Static<typeof collaborationMetadataSchema>;
export type CollaborationAgent = Static<typeof collaborationAgentSchema>;
export type CollaborationCreateInput = Static<typeof collaborationCreateInputSchema>;
export type CollaborationCreateToolInput = Static<typeof collaborationCreateToolInputSchema>;
export type CollaborationAgentPageQuery = Static<typeof collaborationAgentPageQuerySchema>;
export type CollaborationAgentPage = Static<typeof collaborationAgentPageSchema>;
