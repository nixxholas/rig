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

/**
 * What one member may do beyond reading the transcript.
 *
 * Only capabilities Rig enforces appear here. Widening the union later is one
 * line; a literal nothing enforces is a promise the product cannot take back.
 */
export const sessionSharePeerCapabilitySchema = Type.Union([Type.Literal("terminal_view")]);
export type SessionSharePeerCapability = Static<typeof sessionSharePeerCapabilitySchema>;

export const sessionShareMemberSchema = Type.Object(
    {
        /** Capabilities this member holds right now, at their current grant epoch. */
        capabilities: Type.Array(sessionSharePeerCapabilitySchema, { maxItems: 16 }),
        /** The same list written for a person to read, ready to show as-is. */
        capabilitiesDescription: Type.String({ maxLength: 512, minLength: 1 }),
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

/** One capability this project may offer, and why it cannot when it cannot. */
export const sessionShareOfferableCapabilitySchema = Type.Object(
    {
        capability: sessionSharePeerCapabilitySchema,
        /** What it lets the other person do, in one sentence. */
        description: Type.String({ maxLength: 512, minLength: 1 }),
        /**
         * What granting this alone costs that no later action can undo.
         *
         * Shown at grant time, before the owner confirms, not only in a settings
         * page they may never open: anything already seen cannot be recalled, and
         * a credential that crossed a shared terminal has to be rotated.
         */
        grantWarning: Type.String({ maxLength: 1_024, minLength: 1 }),
        label: Type.String({ maxLength: 128, minLength: 1 }),
        /** Present only when `offerable` is false, and always readable English. */
        unavailableReason: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
        offerable: Type.Boolean(),
    },
    exact,
);
export type SessionShareOfferableCapability = Static<typeof sessionShareOfferableCapabilitySchema>;

export const setSessionShareMemberCapabilitiesRequestSchema = Type.Object(
    {
        /** The complete set this member should hold. Not a delta, on purpose. */
        capabilities: Type.Array(sessionSharePeerCapabilitySchema, {
            maxItems: 16,
            uniqueItems: true,
        }),
        mutationId: mutationIdSchema,
    },
    exact,
);
export type SetSessionShareMemberCapabilitiesRequest = Static<
    typeof setSessionShareMemberCapabilitiesRequestSchema
>;

export const sessionSharePeerActivityEntrySchema = Type.Object(
    {
        action: Type.String({ maxLength: 128, minLength: 1 }),
        capability: sessionSharePeerCapabilitySchema,
        createdAt: timestampSchema,
        /** The whole row as one English sentence, ready to show as-is. */
        description: Type.String({ maxLength: 1_024, minLength: 1 }),
        detail: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
        grantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
        seq: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
    },
    exact,
);
export type SessionSharePeerActivityEntry = Static<typeof sessionSharePeerActivityEntrySchema>;

export const getSessionSharePeerActivityResponseSchema = Type.Object(
    {
        complete: Type.Boolean(),
        entries: Type.Array(sessionSharePeerActivityEntrySchema, { maxItems: 100 }),
        nextCursor: Type.Optional(identifierSchema),
    },
    exact,
);
export type GetSessionSharePeerActivityResponse = Static<
    typeof getSessionSharePeerActivityResponseSchema
>;

/** A member asking the owner of a share it replicates to mirror one terminal. */
export const requestSessionSharePeerTerminalRequestSchema = Type.Object(
    { terminalId: identifierSchema },
    exact,
);
export type RequestSessionSharePeerTerminalRequest = Static<
    typeof requestSessionSharePeerTerminalRequestSchema
>;

/**
 * That the request was sent, and nothing about whether it will be honoured.
 *
 * Saying more here would be a guess: the decision is the owner's, is made
 * against the owner's own grant rows and container, and reaches the member as a
 * channel that opens or stays silent.
 */
export const requestSessionSharePeerTerminalResponseSchema = Type.Object(
    { requested: Type.Boolean() },
    exact,
);
export type RequestSessionSharePeerTerminalResponse = Static<
    typeof requestSessionSharePeerTerminalResponseSchema
>;

export const listSessionShareReplicaCapabilitiesResponseSchema = Type.Object(
    {
        capabilities: Type.Array(sessionSharePeerCapabilitySchema, { maxItems: 16 }),
        /** What this replica may do, in the words its own holder reads. */
        description: Type.String({ maxLength: 512, minLength: 1 }),
        shareId: identifierSchema,
    },
    exact,
);
export type ListSessionShareReplicaCapabilitiesResponse = Static<
    typeof listSessionShareReplicaCapabilitiesResponseSchema
>;

export const sessionSharedMetadataSchema = Type.Object(
    {
        /**
         * What members who currently hold a capability may actually do, as a
         * phrase ready to follow "can" — computed from what is granted right
         * now, never from `offerableCapabilities`, so it stays a correct
         * sentence even after the project's own offer disappears out from
         * under an existing grant.
         */
        activeCapabilitiesDescription: Type.String({ maxLength: 512, minLength: 1 }),
        /** How many members hold at least one capability right now. */
        capabilityMemberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        includeFriendMessagesInModel: Type.Boolean(),
        memberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        /** Every capability this project could offer, and why when it cannot. */
        offerableCapabilities: Type.Array(sessionShareOfferableCapabilitySchema, { maxItems: 16 }),
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

/**
 * One member's capabilities changed on a share this daemon owns or replicates.
 *
 * Light and live-only: capability metadata alone, never terminal bytes, so one
 * frame is enough for a client to reconcile a revoke without a bulk payload.
 */
export const sessionShareCapabilitiesChangedEventSchema = Type.Object(
    {
        createdAt: timestampSchema,
        data: Type.Object(
            {
                capabilities: Type.Array(sessionSharePeerCapabilitySchema, { maxItems: 16 }),
                capabilitiesDescription: Type.String({ maxLength: 512, minLength: 1 }),
                memberState: sessionShareMemberStateSchema,
                shareId: identifierSchema,
                shareMemberId: identifierSchema,
            },
            exact,
        ),
        id: identifierSchema,
        type: Type.Literal("session_share_capabilities_changed"),
    },
    exact,
);
export type SessionShareCapabilitiesChangedEvent = Static<
    typeof sessionShareCapabilitiesChangedEventSchema
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
