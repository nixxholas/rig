import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { TypeSystem } from "@sinclair/typebox/system";

/**
 * Projects are module-owned catalog rows. The repository reference remains
 * opaque: a host may use a path, URI, database key, or any other
 * representation without leaking that knowledge here.
 */
export const MAX_PROJECT_ID_LENGTH = 96;
export const MAX_PROJECT_AGENT_ID_LENGTH = 96;
export const MAX_PROJECT_REPOSITORY_REF_LENGTH = 2_048;
export const MAX_PROJECT_NAME_LENGTH = 500;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 2_000;
export const MAX_PROJECT_EVENT_ID_LENGTH = 128;
export const MAX_PROJECT_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_PROJECT_VERSION = Number.MAX_SAFE_INTEGER;
export const MAX_PROJECT_ORDER_KEY_LENGTH = 128;
export const MAX_PROJECT_AVATAR_HASH_LENGTH = 64;
export const MAX_PROJECT_AVATAR_URL_LENGTH = 2_048;
export const MAX_PROJECT_AVATAR_DIMENSION = 16_384;
export const MAX_PROJECT_AVATAR_BYTES = 8 * 1024 * 1024;

export const MAX_PROJECT_SETTINGS_DEPTH = 8;
export const MAX_PROJECT_SETTINGS_STRING_LENGTH = 4_096;
export const MAX_PROJECT_SETTINGS_KEY_LENGTH = 128;
export const MAX_PROJECT_SETTINGS_ITEMS = 64;
export const MAX_PROJECT_SETTINGS_PROPERTIES = 64;
export const MAX_PROJECT_SETTINGS_ENCODED_BYTES = 16 * 1024;

const PROJECT_VISIBLE_IDENTIFIER_PATTERN =
    /^(?=[\s\S]*[^\p{Cc}\p{Cf}\p{Cn}\p{Cs}\p{Zs}\p{Zl}\p{Zp}\p{Mn}\p{Me}])(?:[^\uD800-\uDFFF])+$/u;

function projectVisibleIdentifierSchemaFor(maxLength: number) {
    return Type.String({
        minLength: 1,
        maxLength,
        pattern: PROJECT_VISIBLE_IDENTIFIER_PATTERN.source,
    });
}

export const projectIdSchema = projectVisibleIdentifierSchemaFor(MAX_PROJECT_ID_LENGTH);

export const projectAgentIdSchema = projectVisibleIdentifierSchemaFor(MAX_PROJECT_AGENT_ID_LENGTH);

export const projectRepositoryRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_REPOSITORY_REF_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_NAME_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_DESCRIPTION_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_EVENT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_PROJECT_TIMESTAMP,
});

export const projectVersionSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_PROJECT_VERSION,
});

export const projectOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_ORDER_KEY_LENGTH,
    pattern: "^[0-9]+$",
});

export const projectAvatarHashSchema = Type.String({
    minLength: MAX_PROJECT_AVATAR_HASH_LENGTH,
    maxLength: MAX_PROJECT_AVATAR_HASH_LENGTH,
    pattern: "^[a-f0-9]{64}$",
});

export const projectAvatarMediaTypeSchema = Type.Literal("image/webp");

export const projectAvatarSourceSchema = Type.Union([
    Type.Literal("repository"),
    Type.Literal("hosting"),
    Type.Literal("user"),
]);

export const projectAvatarUrlSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_AVATAR_URL_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectAvatarSchema = Type.Object(
    {
        hash: projectAvatarHashSchema,
        height: Type.Integer({ minimum: 1, maximum: MAX_PROJECT_AVATAR_DIMENSION }),
        mediaType: projectAvatarMediaTypeSchema,
        source: projectAvatarSourceSchema,
        url: projectAvatarUrlSchema,
        width: Type.Integer({ minimum: 1, maximum: MAX_PROJECT_AVATAR_DIMENSION }),
    },
    { additionalProperties: false },
);

export const projectAvatarAssetSchema = Type.Object(
    {
        bytes: Type.Uint8Array({
            minByteLength: 1,
            maxByteLength: MAX_PROJECT_AVATAR_BYTES,
        }),
        hash: projectAvatarHashSchema,
        mediaType: projectAvatarMediaTypeSchema,
    },
    { additionalProperties: false },
);

export const projectStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("archived")]);

export const projectMutationOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("ensure"),
    Type.Literal("rename"),
    Type.Literal("archive"),
    Type.Literal("unarchive"),
    Type.Literal("reorder"),
    Type.Literal("set_avatar"),
    Type.Literal("clear_avatar"),
    Type.Literal("update_settings"),
]);

const projectSettingsLeafSchema = Type.Union([
    Type.String({ maxLength: MAX_PROJECT_SETTINGS_STRING_LENGTH }),
    Type.Number({
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    Type.Boolean(),
    Type.Null(),
]);

const projectPlainObjectSchema = TypeSystem.Type<Record<string, unknown>>(
    "ProjectPlainObject",
    (_schema, value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        try {
            const prototype = Object.getPrototypeOf(value);
            return prototype === Object.prototype || prototype === null;
        } catch {
            return false;
        }
    },
)({ type: "object" });

function projectSettingsRecordSchema<T extends TSchema>(child: T) {
    return Type.Intersect([
        projectPlainObjectSchema,
        Type.Record(Type.String({ maxLength: MAX_PROJECT_SETTINGS_KEY_LENGTH }), child, {
            maxProperties: MAX_PROJECT_SETTINGS_PROPERTIES,
        }),
    ]);
}

function projectSettingsValueAtDepth(depth: number): TSchema {
    if (depth <= 0) return projectSettingsLeafSchema;
    const child = projectSettingsValueAtDepth(depth - 1);
    return Type.Union([
        projectSettingsLeafSchema,
        Type.Array(child, { maxItems: MAX_PROJECT_SETTINGS_ITEMS }),
        projectSettingsRecordSchema(child),
    ]);
}

/**
 * A finite recursive JSON schema. A recursive Type.Record with no depth
 * boundary would still permit an arbitrarily deep persistence value.
 */
export const projectSettingsValueSchema = projectSettingsValueAtDepth(
    MAX_PROJECT_SETTINGS_DEPTH - 1,
);
export const projectSettingsSchema = projectSettingsRecordSchema(projectSettingsValueSchema);

export const projectSchema = Type.Object(
    {
        id: projectIdSchema,
        ownerAgentId: projectAgentIdSchema,
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        status: projectStatusSchema,
        orderKey: projectOrderKeySchema,
        version: projectVersionSchema,
        avatar: Type.Optional(projectAvatarSchema),
        description: Type.Optional(projectDescriptionSchema),
        createdAt: projectTimestampSchema,
        updatedAt: projectTimestampSchema,
        archivedAt: Type.Optional(projectTimestampSchema),
    },
    { additionalProperties: false },
);

/** Host-facing create input. Durable identities are omitted from tool input. */
export const projectCreateInputSchema = Type.Object(
    {
        id: Type.Optional(projectIdSchema),
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

export const projectCreateToolInputSchema = Type.Object(
    {
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

/**
 * Ensure can be called immediately after detecting a repository. A host may
 * derive a display name when the caller has not supplied one.
 */
export const projectEnsureInputSchema = Type.Object(
    {
        repositoryRef: projectRepositoryRefSchema,
        name: Type.Optional(projectNameSchema),
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

export const projectEnsureToolInputSchema = Type.Object(
    {
        repositoryRef: projectRepositoryRefSchema,
        name: Type.Optional(projectNameSchema),
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

export const projectRenameInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        name: projectNameSchema,
    },
    { additionalProperties: false },
);

export const projectRenameToolInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        name: projectNameSchema,
    },
    { additionalProperties: false },
);

/** Positional mutation changes for hosts that already carry the project ID. */
export const projectRenameChangesSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        name: projectNameSchema,
    },
    { additionalProperties: false },
);

export const projectSettingsUpdateInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

export const projectSettingsUpdateToolInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

export const projectUnarchiveInputSchema = Type.Object(
    { projectId: projectIdSchema },
    { additionalProperties: false },
);

export const projectReorderInputSchema = Type.Object(
    {
        afterId: Type.Union([projectIdSchema, Type.Null()]),
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectSetAvatarInputSchema = Type.Object(
    {
        avatar: projectAvatarSchema,
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export const projectClearAvatarInputSchema = Type.Object(
    {
        expectedVersion: Type.Optional(projectVersionSchema),
        projectId: projectIdSchema,
    },
    { additionalProperties: false },
);

export type ProjectId = Static<typeof projectIdSchema>;
export type ProjectAgentId = Static<typeof projectAgentIdSchema>;
export type ProjectRepositoryRef = Static<typeof projectRepositoryRefSchema>;
export type ProjectName = Static<typeof projectNameSchema>;
export type ProjectDescription = Static<typeof projectDescriptionSchema>;
export type ProjectEventId = Static<typeof projectEventIdSchema>;
export type ProjectTimestamp = Static<typeof projectTimestampSchema>;
export type ProjectVersion = Static<typeof projectVersionSchema>;
export type ProjectOrderKey = Static<typeof projectOrderKeySchema>;
export type ProjectAvatarHash = Static<typeof projectAvatarHashSchema>;
export type ProjectAvatarMediaType = Static<typeof projectAvatarMediaTypeSchema>;
export type ProjectAvatarSource = Static<typeof projectAvatarSourceSchema>;
export type ProjectAvatarUrl = Static<typeof projectAvatarUrlSchema>;
export type ProjectAvatar = Static<typeof projectAvatarSchema>;
export type ProjectAvatarAsset = Static<typeof projectAvatarAssetSchema>;
export type ProjectStatus = Static<typeof projectStatusSchema>;
export type ProjectMutationOperation = Static<typeof projectMutationOperationSchema>;
export type ProjectSettingsValue = Static<typeof projectSettingsValueSchema>;
export type ProjectSettings = Static<typeof projectSettingsSchema>;
export type Project = Static<typeof projectSchema>;
export type ProjectCreateInput = Static<typeof projectCreateInputSchema>;
export type ProjectCreateToolInput = Static<typeof projectCreateToolInputSchema>;
export type ProjectEnsureInput = Static<typeof projectEnsureInputSchema>;
export type ProjectEnsureToolInput = Static<typeof projectEnsureToolInputSchema>;
export type ProjectRenameInput = Static<typeof projectRenameInputSchema>;
export type ProjectRenameChanges = Static<typeof projectRenameChangesSchema>;
export type ProjectRenameToolInput = Static<typeof projectRenameToolInputSchema>;
export type ProjectSettingsUpdateInput = Static<typeof projectSettingsUpdateInputSchema>;
export type ProjectSettingsUpdateToolInput = Static<typeof projectSettingsUpdateToolInputSchema>;
export type ProjectUnarchiveInput = Static<typeof projectUnarchiveInputSchema>;
export type ProjectReorderInput = Static<typeof projectReorderInputSchema>;
export type ProjectSetAvatarInput = Static<typeof projectSetAvatarInputSchema>;
export type ProjectClearAvatarInput = Static<typeof projectClearAvatarInputSchema>;
