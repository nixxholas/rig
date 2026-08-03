import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const epochSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });
const sequenceSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

export const sessionShareTransportGrantSchema = Type.Object(
    {
        grantEpoch: epochSchema,
        murmurPeerId: identifierSchema,
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
    },
    exact,
);
export type SessionShareTransportGrant = Static<typeof sessionShareTransportGrantSchema>;

export const sessionShareOpaqueEntrySchema = Type.Object(
    {
        canonicalJson: Type.String({ maxLength: 64 * 1024 * 1024, minLength: 1 }),
        contentHash: Type.String({ maxLength: 256, minLength: 1 }),
        createdAt: timestampSchema,
        shareEventId: identifierSchema,
        shareId: identifierSchema,
        shareSequence: sequenceSchema,
    },
    exact,
);
export type SessionShareOpaqueEntry = Static<typeof sessionShareOpaqueEntrySchema>;

export const sessionShareTransportOwnerSchema = Type.Object(
    {
        ownerPeerId: identifierSchema,
        shareId: identifierSchema,
    },
    exact,
);
export type SessionShareTransportOwner = Static<typeof sessionShareTransportOwnerSchema>;

export const sessionShareTransportMemberPostSchema = Type.Object(
    {
        clientMessageId: identifierSchema,
        /**
         * Advisory label only. The owner renders a friend message under the name it
         * registered for that member, so nothing here carries authority.
         */
        displayName: Type.String({ maxLength: 512, minLength: 1 }),
        grant: sessionShareTransportGrantSchema,
        text: Type.String({ maxLength: 128 * 1024, minLength: 1 }),
    },
    exact,
);
export type SessionShareTransportMemberPost = Static<typeof sessionShareTransportMemberPostSchema>;

export const sessionShareTransportOwnerEventSchema = Type.Union([
    Type.Object(
        {
            post: sessionShareTransportMemberPostSchema,
            senderPeerId: identifierSchema,
            type: Type.Literal("member_posted"),
        },
        exact,
    ),
    Type.Object(
        {
            error: Type.String({ maxLength: 4_096, minLength: 1 }),
            recoverable: Type.Boolean(),
            type: Type.Literal("transport_failed"),
        },
        exact,
    ),
    Type.Object({ type: Type.Literal("transport_recovered") }, exact),
]);
export type SessionShareTransportOwnerEvent = Static<typeof sessionShareTransportOwnerEventSchema>;

export const sessionShareTransportMemberEventSchema = Type.Union([
    Type.Object(
        {
            entries: Type.Array(sessionShareOpaqueEntrySchema, { maxItems: 100, minItems: 1 }),
            grant: sessionShareTransportGrantSchema,
            type: Type.Literal("entries_appended"),
        },
        exact,
    ),
    Type.Object(
        {
            grant: sessionShareTransportGrantSchema,
            reason: Type.Union([Type.Literal("revoked"), Type.Literal("stopped")]),
            type: Type.Literal("ended"),
        },
        exact,
    ),
    Type.Object(
        {
            error: Type.String({ maxLength: 4_096, minLength: 1 }),
            recoverable: Type.Boolean(),
            type: Type.Literal("transport_failed"),
        },
        exact,
    ),
    Type.Object({ type: Type.Literal("transport_recovered") }, exact),
]);
export type SessionShareTransportMemberEvent = Static<
    typeof sessionShareTransportMemberEventSchema
>;

export interface SessionShareTransport {
    createOwner(owner: SessionShareTransportOwner): Promise<void>;
    loadOwner(shareId: string): Promise<SessionShareTransportOwner | undefined>;
    appendOwnerEntries(shareId: string, entries: readonly SessionShareOpaqueEntry[]): Promise<void>;
    inviteMany(grants: readonly SessionShareTransportGrant[]): Promise<void>;
    invite(grant: SessionShareTransportGrant): Promise<void>;
    revoke(grant: SessionShareTransportGrant): Promise<void>;
    stop(shareId: string, grants: readonly SessionShareTransportGrant[]): Promise<void>;
    handleOwnerEvents(
        shareId: string,
        callback: (event: SessionShareTransportOwnerEvent) => void | Promise<void>,
    ): () => void;
    joinMember(grant: SessionShareTransportGrant): Promise<void>;
    loadMember(grant: SessionShareTransportGrant): Promise<SessionShareTransportGrant | undefined>;
    postMember(post: SessionShareTransportMemberPost): Promise<void>;
    handleMemberEvents(
        grant: SessionShareTransportGrant,
        callback: (event: SessionShareTransportMemberEvent) => void | Promise<void>,
    ): () => void;
    retry(shareId: string): Promise<void>;
}
