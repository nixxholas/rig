import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const displayNameSchema = Type.String({ maxLength: 512, minLength: 1 });
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const mutationIdSchema = Type.String({ maxLength: 256, minLength: 1 });

/**
 * What a share covers.
 *
 * A project share is the same machinery as a workspace share over a wider subject
 * set, so the two travel over one set of schemas rather than two.
 */
export const scopeShareScopeKindSchema = Type.Union([
    Type.Literal("workspace"),
    Type.Literal("project"),
]);
export type ScopeShareScopeKind = Static<typeof scopeShareScopeKindSchema>;

export const scopeShareStateSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("degraded"),
    Type.Literal("stopped"),
]);
export type ScopeShareState = Static<typeof scopeShareStateSchema>;

export const scopeShareMemberStateSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("revoked"),
    Type.Literal("stopped"),
]);
export type ScopeShareMemberState = Static<typeof scopeShareMemberStateSchema>;

export const scopeShareGrantSchema = Type.Object(
    {
        grantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        murmurPeerId: identifierSchema,
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
    },
    exact,
);
export type ScopeShareGrant = Static<typeof scopeShareGrantSchema>;

export const scopeShareMemberSchema = Type.Object(
    {
        createdAt: timestampSchema,
        currentGrantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        displayName: displayNameSchema,
        murmurPeerId: identifierSchema,
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
        state: scopeShareMemberStateSchema,
        updatedAt: timestampSchema,
    },
    exact,
);
export type ScopeShareMember = Static<typeof scopeShareMemberSchema>;

/**
 * Enough for a client to draw a badge on a project or workspace without asking a
 * second question about it.
 */
export const scopeSharedMetadataSchema = Type.Object(
    {
        memberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        scopeId: identifierSchema,
        scopeKind: scopeShareScopeKindSchema,
        shareId: identifierSchema,
        state: scopeShareStateSchema,
    },
    exact,
);
export type ScopeSharedMetadata = Static<typeof scopeSharedMetadataSchema>;

export const scopeShareFriendInputSchema = Type.Object(
    { displayName: displayNameSchema, peerId: identifierSchema },
    exact,
);
export type ScopeShareFriendInput = Static<typeof scopeShareFriendInputSchema>;

export const createScopeShareRequestSchema = Type.Object(
    {
        friends: Type.Array(scopeShareFriendInputSchema, {
            maxItems: 100,
            minItems: 1,
            uniqueItems: true,
        }),
        mutationId: mutationIdSchema,
    },
    exact,
);
export type CreateScopeShareRequest = Static<typeof createScopeShareRequestSchema>;

export const addScopeShareMemberRequestSchema = Type.Object(
    { friend: scopeShareFriendInputSchema, mutationId: mutationIdSchema },
    exact,
);
export type AddScopeShareMemberRequest = Static<typeof addScopeShareMemberRequestSchema>;

export const revokeScopeShareMemberRequestSchema = Type.Object(
    { mutationId: mutationIdSchema },
    exact,
);
export type RevokeScopeShareMemberRequest = Static<typeof revokeScopeShareMemberRequestSchema>;

export const stopScopeShareRequestSchema = Type.Object({ mutationId: mutationIdSchema }, exact);
export type StopScopeShareRequest = Static<typeof stopScopeShareRequestSchema>;

export const scopeShareOwnerResponseSchema = Type.Object(
    {
        members: Type.Array(scopeShareMemberSchema, { maxItems: 10_000 }),
        share: scopeSharedMetadataSchema,
    },
    exact,
);
export type ScopeShareOwnerResponse = Static<typeof scopeShareOwnerResponseSchema>;

/** Why a replica stopped: the owner retired it, or this daemon could not read it. */
export const scopeShareReplicaEndedReasonSchema = Type.Union([
    Type.Literal("revoked"),
    Type.Literal("stopped"),
    Type.Literal("unreadable"),
]);
export type ScopeShareReplicaEndedReason = Static<typeof scopeShareReplicaEndedReasonSchema>;

export const scopeShareReplicaSchema = Type.Object(
    {
        createdAt: timestampSchema,
        endedAt: Type.Optional(timestampSchema),
        endedReason: Type.Optional(scopeShareReplicaEndedReasonSchema),
        grant: scopeShareGrantSchema,
        memberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        ownerPeerId: identifierSchema,
        scopeKind: scopeShareScopeKindSchema,
        state: Type.Union([Type.Literal("active"), Type.Literal("ended")]),
        title: Type.String({ maxLength: 2_048 }),
        updatedAt: timestampSchema,
    },
    exact,
);
export type ScopeShareReplica = Static<typeof scopeShareReplicaSchema>;

export const listScopeShareReplicasResponseSchema = Type.Object(
    { replicas: Type.Array(scopeShareReplicaSchema, { maxItems: 1_000 }) },
    exact,
);
export type ListScopeShareReplicasResponse = Static<typeof listScopeShareReplicasResponseSchema>;

/**
 * One replicated entry, exactly as the owner published it.
 *
 * The canonical JSON travels rather than a decoded shape so a member verifies the
 * same bytes the content hash covers, and decodes them with the one shared
 * projection schema instead of a second, drifting copy of it.
 */
export const scopeShareReplicaEntrySchema = Type.Object(
    {
        canonicalJson: Type.String({ maxLength: 1_048_576, minLength: 1 }),
        createdAt: timestampSchema,
        shareEventId: identifierSchema,
        shareSequence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type ScopeShareReplicaEntry = Static<typeof scopeShareReplicaEntrySchema>;

export const getScopeShareReplicaResponseSchema = Type.Object(
    {
        complete: Type.Boolean(),
        /** The scope's own facts and its session list, without any transcript. */
        entries: Type.Array(scopeShareReplicaEntrySchema, { maxItems: 100 }),
        nextCursor: Type.Optional(identifierSchema),
        replica: scopeShareReplicaSchema,
    },
    exact,
);
export type GetScopeShareReplicaResponse = Static<typeof getScopeShareReplicaResponseSchema>;

export const getScopeShareSessionHistoryResponseSchema = Type.Object(
    {
        complete: Type.Boolean(),
        entries: Type.Array(scopeShareReplicaEntrySchema, { maxItems: 100 }),
        nextCursor: Type.Optional(identifierSchema),
        replica: scopeShareReplicaSchema,
        sessionId: identifierSchema,
    },
    exact,
);
export type GetScopeShareSessionHistoryResponse = Static<
    typeof getScopeShareSessionHistoryResponseSchema
>;

export const scopeShareHealthSchema = Type.Object(
    {
        checkedAt: timestampSchema,
        detail: Type.Optional(Type.String({ maxLength: 2_048, minLength: 1 })),
        pendingBytes: Type.Integer({ maximum: 64 * 1024 * 1024, minimum: 0 }),
        pendingEntries: Type.Integer({ maximum: 100_000, minimum: 0 }),
        state: scopeShareStateSchema,
    },
    exact,
);
export type ScopeShareHealth = Static<typeof scopeShareHealthSchema>;

export const getScopeShareHealthResponseSchema = Type.Object(
    { health: scopeShareHealthSchema },
    exact,
);
export type GetScopeShareHealthResponse = Static<typeof getScopeShareHealthResponseSchema>;
