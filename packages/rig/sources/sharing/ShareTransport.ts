import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const epochSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });
const sequenceSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 });
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

export const shareTransportGrantSchema = Type.Object(
    {
        grantEpoch: epochSchema,
        murmurPeerId: identifierSchema,
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
    },
    exact,
);
export type ShareTransportGrant = Static<typeof shareTransportGrantSchema>;

export const shareOpaqueEntrySchema = Type.Object(
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
export type ShareOpaqueEntry = Static<typeof shareOpaqueEntrySchema>;

export const shareTransportOwnerSchema = Type.Object(
    {
        ownerPeerId: identifierSchema,
        shareId: identifierSchema,
    },
    exact,
);
export type ShareTransportOwner = Static<typeof shareTransportOwnerSchema>;

export const shareTransportMemberPostSchema = Type.Object(
    {
        clientMessageId: identifierSchema,
        /**
         * Advisory label only. The owner renders a friend message under the name it
         * registered for that member, so nothing here carries authority.
         */
        displayName: Type.String({ maxLength: 512, minLength: 1 }),
        grant: shareTransportGrantSchema,
        text: Type.String({ maxLength: 128 * 1024, minLength: 1 }),
    },
    exact,
);
export type ShareTransportMemberPost = Static<typeof shareTransportMemberPostSchema>;

export const shareTransportOwnerEventSchema = Type.Union([
    Type.Object(
        {
            post: shareTransportMemberPostSchema,
            senderPeerId: identifierSchema,
            type: Type.Literal("member_posted"),
        },
        exact,
    ),
    Type.Object(
        {
            error: Type.String({ maxLength: 4_096, minLength: 1 }),
            // An unrecoverable failure means Murmur retired the group; no retry brings it back.
            recoverable: Type.Boolean(),
            shareId: identifierSchema,
            type: Type.Literal("transport_failed"),
        },
        exact,
    ),
    Type.Object({ shareId: identifierSchema, type: Type.Literal("transport_recovered") }, exact),
]);
export type ShareTransportOwnerEvent = Static<typeof shareTransportOwnerEventSchema>;

export const shareTransportMemberEventSchema = Type.Union([
    Type.Object(
        {
            entries: Type.Array(shareOpaqueEntrySchema, { maxItems: 100, minItems: 1 }),
            grant: shareTransportGrantSchema,
            type: Type.Literal("entries_appended"),
        },
        exact,
    ),
    Type.Object(
        {
            grant: shareTransportGrantSchema,
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
export type ShareTransportMemberEvent = Static<typeof shareTransportMemberEventSchema>;

export interface ShareTransport {
    createOwner(owner: ShareTransportOwner): Promise<void>;
    loadOwner(shareId: string): Promise<ShareTransportOwner | undefined>;
    appendOwnerEntries(shareId: string, entries: readonly ShareOpaqueEntry[]): Promise<void>;
    inviteMany(grants: readonly ShareTransportGrant[]): Promise<void>;
    invite(grant: ShareTransportGrant): Promise<void>;
    revoke(grant: ShareTransportGrant): Promise<void>;
    stop(shareId: string, grants: readonly ShareTransportGrant[]): Promise<void>;
    handleOwnerEvents(
        shareId: string,
        callback: (event: ShareTransportOwnerEvent) => void | Promise<void>,
    ): () => void;
    joinMember(grant: ShareTransportGrant): Promise<void>;
    loadMember(grant: ShareTransportGrant): Promise<ShareTransportGrant | undefined>;
    postMember(post: ShareTransportMemberPost): Promise<void>;
    handleMemberEvents(
        grant: ShareTransportGrant,
        callback: (event: ShareTransportMemberEvent) => void | Promise<void>,
    ): () => void;
    /** Retry a share's transport work, reporting whether it moved any history. */
    retry(shareId: string): Promise<boolean>;
}
