import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const displayNameSchema = Type.String({ maxLength: 512, minLength: 1 });
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const mutationIdSchema = Type.String({ maxLength: 256, minLength: 1 });

/**
 * How much of each tool's work a share replicates.
 *
 * `summaries` is what a share has unless its owner asked for more, including a
 * request that leaves the field out. `full` additionally replicates the raw
 * arguments and output of the tools that declared themselves disclosable.
 */
export const sessionShareToolOutputSchema = Type.Union([
    Type.Literal("summaries"),
    Type.Literal("full"),
]);
export type SessionShareToolOutput = Static<typeof sessionShareToolOutputSchema>;

export const sessionShareStateSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("degraded"),
    Type.Literal("stopped"),
]);
export type SessionShareState = Static<typeof sessionShareStateSchema>;

export const sessionShareMemberStateSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("revoked"),
    Type.Literal("stopped"),
]);
export type SessionShareMemberState = Static<typeof sessionShareMemberStateSchema>;

export const sessionShareGrantSchema = Type.Object(
    {
        grantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        murmurPeerId: identifierSchema,
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
    },
    exact,
);
export type SessionShareGrant = Static<typeof sessionShareGrantSchema>;

export const sessionShareMemberSchema = Type.Object(
    {
        createdAt: timestampSchema,
        currentGrantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        displayName: displayNameSchema,
        murmurPeerId: identifierSchema,
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
        state: sessionShareMemberStateSchema,
        updatedAt: timestampSchema,
    },
    exact,
);
export type SessionShareMember = Static<typeof sessionShareMemberSchema>;

export const sessionSharedMetadataSchema = Type.Object(
    {
        includeFriendMessagesInModel: Type.Boolean(),
        memberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        shareId: identifierSchema,
        state: sessionShareStateSchema,
        toolOutput: sessionShareToolOutputSchema,
        /** Sentence describing what friends currently see, ready to show as-is. */
        toolOutputDescription: Type.String({ maxLength: 512, minLength: 1 }),
    },
    exact,
);
export type SessionSharedMetadata = Static<typeof sessionSharedMetadataSchema>;

export const sessionShareFriendInputSchema = Type.Object(
    {
        displayName: displayNameSchema,
        peerId: identifierSchema,
    },
    exact,
);
export type SessionShareFriendInput = Static<typeof sessionShareFriendInputSchema>;

export const createSessionShareRequestSchema = Type.Object(
    {
        friends: Type.Array(sessionShareFriendInputSchema, {
            maxItems: 100,
            minItems: 1,
            uniqueItems: true,
        }),
        includeFriendMessagesInModel: Type.Boolean(),
        mutationId: mutationIdSchema,
        /** Omitted means summaries: full output is only ever something asked for. */
        toolOutput: Type.Optional(sessionShareToolOutputSchema),
    },
    exact,
);
export type CreateSessionShareRequest = Static<typeof createSessionShareRequestSchema>;

export const addSessionShareMemberRequestSchema = Type.Object(
    {
        friend: sessionShareFriendInputSchema,
        mutationId: mutationIdSchema,
    },
    exact,
);
export type AddSessionShareMemberRequest = Static<typeof addSessionShareMemberRequestSchema>;

export const revokeSessionShareMemberRequestSchema = Type.Object(
    { mutationId: mutationIdSchema },
    exact,
);
export type RevokeSessionShareMemberRequest = Static<typeof revokeSessionShareMemberRequestSchema>;

export const stopSessionShareRequestSchema = Type.Object({ mutationId: mutationIdSchema }, exact);
export type StopSessionShareRequest = Static<typeof stopSessionShareRequestSchema>;

export const setSessionShareFriendMessagesRequestSchema = Type.Object(
    {
        includeFriendMessagesInModel: Type.Boolean(),
        mutationId: mutationIdSchema,
    },
    exact,
);
export type SetSessionShareFriendMessagesRequest = Static<
    typeof setSessionShareFriendMessagesRequestSchema
>;

export const setSessionShareToolOutputRequestSchema = Type.Object(
    {
        mutationId: mutationIdSchema,
        toolOutput: sessionShareToolOutputSchema,
    },
    exact,
);
export type SetSessionShareToolOutputRequest = Static<
    typeof setSessionShareToolOutputRequestSchema
>;

export const postSessionShareFriendMessageRequestSchema = Type.Object(
    {
        clientMessageId: identifierSchema,
        grant: sessionShareGrantSchema,
        text: Type.String({ maxLength: 100_000, minLength: 1 }),
    },
    exact,
);
export type PostSessionShareFriendMessageRequest = Static<
    typeof postSessionShareFriendMessageRequestSchema
>;

export const sessionShareOwnerResponseSchema = Type.Object(
    {
        members: Type.Array(sessionShareMemberSchema, { maxItems: 10_000 }),
        share: sessionSharedMetadataSchema,
    },
    exact,
);
export type SessionShareOwnerResponse = Static<typeof sessionShareOwnerResponseSchema>;

export const postSessionShareFriendMessageResponseSchema = Type.Object(
    {
        accepted: Type.Boolean(),
        clientMessageId: identifierSchema,
    },
    exact,
);
export type PostSessionShareFriendMessageResponse = Static<
    typeof postSessionShareFriendMessageResponseSchema
>;

/** Why a replica stopped: the owner retired it, or this daemon could not read it. */
export const sessionShareReplicaEndedReasonSchema = Type.Union([
    Type.Literal("revoked"),
    Type.Literal("stopped"),
    Type.Literal("unreadable"),
]);
export type SessionShareReplicaEndedReason = Static<typeof sessionShareReplicaEndedReasonSchema>;

export const sessionShareReplicaSchema = Type.Object(
    {
        createdAt: timestampSchema,
        endedAt: Type.Optional(timestampSchema),
        endedReason: Type.Optional(sessionShareReplicaEndedReasonSchema),
        grant: sessionShareGrantSchema,
        memberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        ownerPeerId: identifierSchema,
        state: Type.Union([Type.Literal("active"), Type.Literal("ended")]),
        title: Type.String({ maxLength: 2_048 }),
        updatedAt: timestampSchema,
    },
    exact,
);
export type SessionShareReplica = Static<typeof sessionShareReplicaSchema>;

export const listSessionShareReplicasResponseSchema = Type.Object(
    { replicas: Type.Array(sessionShareReplicaSchema, { maxItems: 1_000 }) },
    exact,
);
export type ListSessionShareReplicasResponse = Static<
    typeof listSessionShareReplicasResponseSchema
>;

export const sessionShareReplicaHistoryEntrySchema = Type.Object(
    {
        canonicalJson: Type.String({ maxLength: 1_048_576, minLength: 1 }),
        createdAt: timestampSchema,
        shareEventId: identifierSchema,
        shareSequence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type SessionShareReplicaHistoryEntry = Static<typeof sessionShareReplicaHistoryEntrySchema>;

export const getSessionShareReplicaHistoryResponseSchema = Type.Object(
    {
        complete: Type.Boolean(),
        entries: Type.Array(sessionShareReplicaHistoryEntrySchema, { maxItems: 100 }),
        nextCursor: Type.Optional(identifierSchema),
        replica: sessionShareReplicaSchema,
    },
    exact,
);
export type GetSessionShareReplicaHistoryResponse = Static<
    typeof getSessionShareReplicaHistoryResponseSchema
>;

export const sessionShareHealthSchema = Type.Object(
    {
        checkedAt: timestampSchema,
        detail: Type.Optional(Type.String({ maxLength: 2_048, minLength: 1 })),
        pendingBytes: Type.Integer({ maximum: 64 * 1024 * 1024, minimum: 0 }),
        pendingEntries: Type.Integer({ maximum: 100_000, minimum: 0 }),
        state: sessionShareStateSchema,
    },
    exact,
);
export type SessionShareHealth = Static<typeof sessionShareHealthSchema>;

export const getSessionShareHealthResponseSchema = Type.Object(
    { health: sessionShareHealthSchema },
    exact,
);
export type GetSessionShareHealthResponse = Static<typeof getSessionShareHealthResponseSchema>;
