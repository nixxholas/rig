import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const base64Schema = Type.String({
    maxLength: 32 * 1024 * 1024,
    minLength: 1,
    pattern: "^[A-Za-z0-9+/]*={0,2}$",
});
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const nameSchema = Type.String({ maxLength: 128, minLength: 1 });
const profileLastNameSchema = Type.String({ maxLength: 128 });
const thumbhashSchema = Type.String({ maxLength: 1_024, minLength: 1 });
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const tokenSchema = Type.String({ maxLength: 4_096, minLength: 1 });

export const murmurPhotoInputSchema = Type.Object(
    {
        data: base64Schema,
        mediaType: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type MurmurPhotoInput = Static<typeof murmurPhotoInputSchema>;

export const murmurPhotoSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: 24 * 1024 * 1024, minimum: 0 }),
        data: base64Schema,
        height: Type.Integer({ maximum: 16_384, minimum: 1 }),
        mediaType: Type.Literal("image/webp"),
        thumbhash: thumbhashSchema,
        width: Type.Integer({ maximum: 16_384, minimum: 1 }),
    },
    exact,
);
export type MurmurPhoto = Static<typeof murmurPhotoSchema>;

export const murmurProfileSchema = Type.Object(
    {
        firstName: nameSchema,
        lastName: profileLastNameSchema,
        photo: Type.Optional(murmurPhotoSchema),
    },
    exact,
);
export type MurmurProfile = Static<typeof murmurProfileSchema>;

export const murmurAccountSchema = Type.Object(
    {
        id: identifierSchema,
        profile: murmurProfileSchema,
        token: tokenSchema,
    },
    exact,
);
export type MurmurAccount = Static<typeof murmurAccountSchema>;

export const murmurServiceStateSchema = Type.Object(
    {
        relayUrls: Type.Array(Type.String({ maxLength: 2_048, minLength: 1 }), {
            maxItems: 16,
            uniqueItems: true,
        }),
        status: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
    },
    exact,
);
export type MurmurServiceState = Static<typeof murmurServiceStateSchema>;

export const murmurFriendshipStateSchema = Type.Union([
    Type.Literal("incoming_pending"),
    Type.Literal("outgoing_pending"),
    Type.Literal("friends"),
    Type.Literal("rejected_incoming"),
    Type.Literal("rejected_outgoing"),
]);
export type MurmurFriendshipState = Static<typeof murmurFriendshipStateSchema>;

export const murmurFriendshipDirectionSchema = Type.Union([
    Type.Literal("incoming"),
    Type.Literal("outgoing"),
    Type.Literal("mutual"),
]);
export type MurmurFriendshipDirection = Static<typeof murmurFriendshipDirectionSchema>;

export const murmurFriendshipHistorySchema = Type.Object(
    {
        accepted: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        autoAccepted: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        received: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        rejected: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        sent: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    },
    exact,
);
export type MurmurFriendshipHistory = Static<typeof murmurFriendshipHistorySchema>;

export const murmurFriendshipSchema = Type.Object(
    {
        answeredAt: Type.Optional(timestampSchema),
        autoAcceptEligible: Type.Boolean(),
        direction: murmurFriendshipDirectionSchema,
        firstSeenAt: timestampSchema,
        history: murmurFriendshipHistorySchema,
        peerId: identifierSchema,
        profile: Type.Optional(murmurProfileSchema),
        requestId: Type.Optional(identifierSchema),
        state: murmurFriendshipStateSchema,
        token: tokenSchema,
        updatedAt: timestampSchema,
        version: identifierSchema,
    },
    exact,
);
export type MurmurFriendship = Static<typeof murmurFriendshipSchema>;

export const murmurFriendStatsSchema = Type.Object(
    {
        acceptedRequests: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        autoAcceptedRequests: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        contacts: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        incomingPending: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        outgoingPending: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        rejectedRequests: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    },
    exact,
);
export type MurmurFriendStats = Static<typeof murmurFriendStatsSchema>;

export const murmurFriendshipChangedReasonSchema = Type.Union([
    Type.Literal("request_received"),
    Type.Literal("request_sent"),
    Type.Literal("accepted"),
    Type.Literal("rejected"),
    Type.Literal("auto_accepted"),
    Type.Literal("profile_updated"),
]);
export type MurmurFriendshipChangedReason = Static<typeof murmurFriendshipChangedReasonSchema>;

export const murmurFriendshipChangedEventSchema = Type.Object(
    {
        createdAt: timestampSchema,
        data: Type.Object(
            {
                direction: murmurFriendshipDirectionSchema,
                reason: murmurFriendshipChangedReasonSchema,
                state: murmurFriendshipStateSchema,
            },
            exact,
        ),
        id: identifierSchema,
        murmurPeerId: identifierSchema,
        type: Type.Literal("murmur_friendship_changed"),
    },
    exact,
);
export type MurmurFriendshipChangedEvent = Static<typeof murmurFriendshipChangedEventSchema>;

export const getMurmurAccountResponseSchema = Type.Object(
    {
        account: Type.Optional(murmurAccountSchema),
        service: murmurServiceStateSchema,
    },
    exact,
);
export type GetMurmurAccountResponse = Static<typeof getMurmurAccountResponseSchema>;

export const signupMurmurAccountRequestSchema = Type.Object(
    {
        firstName: nameSchema,
        lastName: nameSchema,
        photo: Type.Optional(murmurPhotoInputSchema),
    },
    exact,
);
export type SignupMurmurAccountRequest = Static<typeof signupMurmurAccountRequestSchema>;

export const signupMurmurAccountResponseSchema = Type.Object(
    {
        account: murmurAccountSchema,
        service: murmurServiceStateSchema,
    },
    exact,
);
export type SignupMurmurAccountResponse = Static<typeof signupMurmurAccountResponseSchema>;

export const startMurmurServiceRequestSchema = Type.Object(
    {
        relayUrls: Type.Optional(
            Type.Array(Type.String({ maxLength: 2_048, minLength: 1 }), {
                maxItems: 16,
                uniqueItems: true,
            }),
        ),
    },
    exact,
);
export type StartMurmurServiceRequest = Static<typeof startMurmurServiceRequestSchema>;

export const startMurmurServiceResponseSchema = Type.Object(
    { service: murmurServiceStateSchema },
    exact,
);
export type StartMurmurServiceResponse = Static<typeof startMurmurServiceResponseSchema>;

export const stopMurmurServiceResponseSchema = Type.Object(
    { service: murmurServiceStateSchema },
    exact,
);
export type StopMurmurServiceResponse = Static<typeof stopMurmurServiceResponseSchema>;

export const deleteMurmurAccountResponseSchema = Type.Object({ deleted: Type.Boolean() }, exact);
export type DeleteMurmurAccountResponse = Static<typeof deleteMurmurAccountResponseSchema>;

export const sendMurmurFriendRequestRequestSchema = Type.Object({ token: tokenSchema }, exact);
export type SendMurmurFriendRequestRequest = Static<typeof sendMurmurFriendRequestRequestSchema>;

export const sendMurmurFriendRequestResponseSchema = Type.Object(
    {
        friendship: murmurFriendshipSchema,
        queued: Type.Boolean(),
        recipientId: identifierSchema,
        stats: murmurFriendStatsSchema,
    },
    exact,
);
export type SendMurmurFriendRequestResponse = Static<typeof sendMurmurFriendRequestResponseSchema>;

export const murmurFriendRequestSchema = Type.Object(
    {
        id: identifierSchema,
        profile: murmurProfileSchema,
        receivedAt: timestampSchema,
        senderId: identifierSchema,
        senderToken: tokenSchema,
    },
    exact,
);
export type MurmurFriendRequest = Static<typeof murmurFriendRequestSchema>;

export const listMurmurFriendRequestsResponseSchema = Type.Object(
    {
        requests: Type.Array(murmurFriendRequestSchema, { maxItems: 10_000 }),
    },
    exact,
);
export type ListMurmurFriendRequestsResponse = Static<
    typeof listMurmurFriendRequestsResponseSchema
>;

export const answerMurmurFriendRequestRequestSchema = Type.Object(
    {
        answer: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
    },
    exact,
);
export type AnswerMurmurFriendRequestRequest = Static<
    typeof answerMurmurFriendRequestRequestSchema
>;

export const murmurContactSchema = Type.Object(
    {
        addedAt: timestampSchema,
        id: identifierSchema,
        profile: murmurProfileSchema,
        token: tokenSchema,
        updatedAt: timestampSchema,
    },
    exact,
);
export type MurmurContact = Static<typeof murmurContactSchema>;

export const answerMurmurFriendRequestResponseSchema = Type.Object(
    {
        answer: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
        contact: Type.Optional(murmurContactSchema),
        friendship: murmurFriendshipSchema,
        stats: murmurFriendStatsSchema,
    },
    exact,
);
export type AnswerMurmurFriendRequestResponse = Static<
    typeof answerMurmurFriendRequestResponseSchema
>;

export const listMurmurContactsResponseSchema = Type.Object(
    {
        contacts: Type.Array(murmurContactSchema, { maxItems: 10_000 }),
    },
    exact,
);
export type ListMurmurContactsResponse = Static<typeof listMurmurContactsResponseSchema>;

export const getMurmurFriendsResponseSchema = Type.Object(
    {
        account: Type.Optional(murmurAccountSchema),
        contacts: Type.Array(murmurContactSchema, { maxItems: 10_000 }),
        friendships: Type.Array(murmurFriendshipSchema, { maxItems: 10_000 }),
        service: murmurServiceStateSchema,
        stats: murmurFriendStatsSchema,
    },
    exact,
);
export type GetMurmurFriendsResponse = Static<typeof getMurmurFriendsResponseSchema>;
