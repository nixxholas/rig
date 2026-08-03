import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    decodeBase64Url,
    decodeEncryptedPrivateMessage,
    decodeSignedRelayEventWire,
    deserializePublicIdentity,
    encodeBase64Url,
    encodeEncryptedPrivateMessage,
    encodeSignedRelayEventWire,
    serializePublicIdentity,
    utf8Decode,
    utf8Encode,
    validateIdentityProfile,
    verifyRelayEvent,
    zeroBytes,
    type EncryptedPrivateMessage,
    type EncryptedProfile,
    type IdentityProfile,
    type IdentityPublicKeys,
    type SignedRelayEvent,
} from "@slopus/murmur";
import { MAX_MURMUR_PROFILE_PHOTO_BYTES } from "./photoNormalize.js";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^[A-Za-z0-9_-]+$",
});
const base64UrlSchema = Type.String({
    maxLength: 2 * 1024 * 1024,
    minLength: 1,
    pattern: "^[A-Za-z0-9_-]+$",
});
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const countSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const publicIdentitySchema = Type.Object(
    {
        encryptionKey: Type.String({
            maxLength: 43,
            minLength: 43,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
        signingKey: Type.String({
            maxLength: 43,
            minLength: 43,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
    },
    exact,
);
const storedProfileSchema = Type.Object(
    {
        avatar: Type.Optional(base64UrlSchema),
        metadata: Type.Optional(
            Type.Record(
                Type.String({ maxLength: 128, minLength: 1 }),
                Type.String({ maxLength: 2_048 }),
                { maxProperties: 64 },
            ),
        ),
        name: Type.String({ maxLength: 512, minLength: 1 }),
    },
    exact,
);
const friendshipMetadataNameSchema = Type.String({ maxLength: 128, minLength: 1 });
const friendshipPhotoDimensionSchema = Type.String({ pattern: "^[1-9][0-9]{0,3}$" });
const friendshipPhotoMediaTypeSchema = Type.Literal("image/webp");
const friendshipPhotoThumbhashSchema = Type.String({ maxLength: 1_024, minLength: 1 });
const friendshipStateSchema = Type.Union([
    Type.Literal("incoming_pending"),
    Type.Literal("outgoing_pending"),
    Type.Literal("friends"),
    Type.Literal("rejected_incoming"),
    Type.Literal("rejected_outgoing"),
]);
const friendshipDirectionSchema = Type.Union([
    Type.Literal("incoming"),
    Type.Literal("outgoing"),
    Type.Literal("mutual"),
]);
const friendshipHistorySchema = Type.Object(
    {
        accepted: countSchema,
        autoAccepted: countSchema,
        received: countSchema,
        rejected: countSchema,
        sent: countSchema,
    },
    exact,
);
const storedFriendshipSchema = Type.Object(
    {
        answeredAt: Type.Optional(timestampSchema),
        autoAcceptEligible: Type.Boolean(),
        direction: friendshipDirectionSchema,
        eventVersion: identifierSchema,
        firstSeenAt: timestampSchema,
        history: friendshipHistorySchema,
        identity: publicIdentitySchema,
        profile: Type.Optional(storedProfileSchema),
        requestId: Type.Optional(identifierSchema),
        state: friendshipStateSchema,
        updatedAt: timestampSchema,
        version: Type.Literal(1),
    },
    exact,
);
const friendshipControlSchema = Type.Object(
    {
        action: Type.Union([
            Type.Literal("request"),
            Type.Literal("accept"),
            Type.Literal("reject"),
        ]),
        eventVersion: identifierSchema,
        kind: Type.Literal("rig.murmur.friendship-control.v1"),
        requestId: identifierSchema,
        sentAt: timestampSchema,
        version: Type.Literal(1),
    },
    exact,
);
const encryptedProfileSchema = Type.Object(
    {
        ciphertext: base64UrlSchema,
        ephemeralPublicKey: Type.String({ maxLength: 43, minLength: 43 }),
        nonce: Type.String({ maxLength: 16, minLength: 16 }),
        recipient: Type.String({ maxLength: 43, minLength: 43 }),
        version: Type.Literal(1),
    },
    exact,
);
const encryptedPrivateMessageSchema = Type.Object(
    {
        ciphertext: base64UrlSchema,
        ephemeralPublicKey: Type.String({ maxLength: 43, minLength: 43 }),
        nonce: Type.String({ maxLength: 16, minLength: 16 }),
        recipient: Type.String({ maxLength: 43, minLength: 43 }),
        sender: publicIdentitySchema,
        version: Type.Literal(1),
    },
    exact,
);
const profileEnvelopeSchema = Type.Object(
    {
        encrypted: encryptedProfileSchema,
        kind: Type.Literal("rig.murmur.friendship-profile.v1"),
        version: Type.Literal(1),
    },
    exact,
);
const privateEnvelopeSchema = Type.Object(
    {
        encrypted: encryptedPrivateMessageSchema,
        kind: Type.Literal("rig.murmur.friendship-private.v1"),
        version: Type.Literal(1),
    },
    exact,
);
const cleanupEnvelopeSchema = Type.Object(
    {
        elementId: Type.String({ maxLength: 256, minLength: 1 }),
        kind: Type.Literal("rig.murmur.friendship-cleanup.v1"),
        version: Type.Literal(1),
    },
    exact,
);
const storedRelayOutboxSchema = Type.Object(
    {
        event: base64UrlSchema,
        publishedRelayIds: Type.Array(Type.String({ maxLength: 128, minLength: 1 }), {
            maxItems: 16,
            uniqueItems: true,
        }),
        version: Type.Literal(1),
    },
    exact,
);
const globalReasonSchema = Type.Union([
    Type.Literal("request_received"),
    Type.Literal("request_sent"),
    Type.Literal("accepted"),
    Type.Literal("rejected"),
    Type.Literal("auto_accepted"),
    Type.Literal("profile_updated"),
]);
const storedGlobalEventSchema = Type.Object(
    {
        createdAt: timestampSchema,
        data: Type.Object(
            {
                direction: friendshipDirectionSchema,
                reason: globalReasonSchema,
                state: friendshipStateSchema,
            },
            exact,
        ),
        id: identifierSchema,
        murmurPeerId: identifierSchema,
        type: Type.Literal("murmur_friendship_changed"),
        version: Type.Literal(1),
    },
    exact,
);
const quarantineSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: 2 * 1024 * 1024, minimum: 0 }),
        createdAt: timestampSchema,
        reason: Type.String({ maxLength: 128, minLength: 1 }),
        version: Type.Literal(1),
    },
    exact,
);
const storedCountSchema = Type.Object(
    {
        count: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        version: Type.Literal(1),
    },
    exact,
);

export type FriendshipState = Static<typeof friendshipStateSchema>;
export type FriendshipDirection = Static<typeof friendshipDirectionSchema>;
export type FriendshipHistory = Static<typeof friendshipHistorySchema>;
export type FriendshipControl = Static<typeof friendshipControlSchema>;
export type StoredFriendship = Static<typeof storedFriendshipSchema>;
export type StoredGlobalFriendshipEvent = Static<typeof storedGlobalEventSchema>;
export type GlobalFriendshipReason = Static<typeof globalReasonSchema>;

export type FriendshipWireEnvelope =
    | {
          readonly kind: "profile";
          readonly encrypted: EncryptedProfile;
      }
    | {
          readonly kind: "private";
          readonly encrypted: EncryptedPrivateMessage;
      }
    | {
          readonly kind: "cleanup";
          readonly elementId: string;
      };

function parseJson(bytes: Uint8Array): unknown {
    return JSON.parse(utf8Decode(bytes)) as unknown;
}

function encodeValidated<Schema extends Parameters<typeof Value.Decode>[0]>(
    schema: Schema,
    value: unknown,
): Uint8Array {
    return utf8Encode(JSON.stringify(Value.Decode(schema, value)));
}

export function encodeFriendshipControl(control: FriendshipControl): Uint8Array {
    return encodeValidated(friendshipControlSchema, control);
}

export function decodeFriendshipControl(bytes: Uint8Array): FriendshipControl {
    return Value.Decode(friendshipControlSchema, parseJson(bytes));
}

export function encodeFriendshipControlText(control: FriendshipControl): string {
    const bytes = encodeFriendshipControl(control);
    try {
        return utf8Decode(bytes);
    } finally {
        zeroBytes(bytes);
    }
}

export function decodeFriendshipControlText(text: string): FriendshipControl {
    const bytes = utf8Encode(text);
    try {
        return decodeFriendshipControl(bytes);
    } finally {
        zeroBytes(bytes);
    }
}

export function encodeFriendshipProfileEnvelope(encrypted: EncryptedProfile): Uint8Array {
    return encodeValidated(profileEnvelopeSchema, {
        encrypted,
        kind: "rig.murmur.friendship-profile.v1",
        version: 1,
    });
}

export function encodeFriendshipPrivateEnvelope(encrypted: EncryptedPrivateMessage): Uint8Array {
    const strict = encodeEncryptedPrivateMessage(encrypted);
    try {
        return encodeValidated(privateEnvelopeSchema, {
            encrypted,
            kind: "rig.murmur.friendship-private.v1",
            version: 1,
        });
    } finally {
        zeroBytes(strict);
    }
}

export function encodeFriendshipCleanupEnvelope(elementId: string): Uint8Array {
    return encodeValidated(cleanupEnvelopeSchema, {
        elementId,
        kind: "rig.murmur.friendship-cleanup.v1",
        version: 1,
    });
}

export function decodeFriendshipWireEnvelope(bytes: Uint8Array): FriendshipWireEnvelope {
    const value = parseJson(bytes);
    if (
        Value.Check(profileEnvelopeSchema, value) &&
        Value.Decode(profileEnvelopeSchema, value).kind === "rig.murmur.friendship-profile.v1"
    ) {
        return {
            encrypted: Value.Decode(profileEnvelopeSchema, value).encrypted,
            kind: "profile",
        };
    }
    if (Value.Check(cleanupEnvelopeSchema, value)) {
        const cleanup = Value.Decode(cleanupEnvelopeSchema, value);
        return { elementId: cleanup.elementId, kind: "cleanup" };
    }
    const privateEnvelope = Value.Decode(privateEnvelopeSchema, value);
    const strictBytes = utf8Encode(JSON.stringify(privateEnvelope.encrypted));
    try {
        return {
            encrypted: decodeEncryptedPrivateMessage(strictBytes),
            kind: "private",
        };
    } finally {
        zeroBytes(strictBytes);
    }
}

export function serializeFriendshipIdentity(
    identity: IdentityPublicKeys,
): Static<typeof publicIdentitySchema> {
    return Value.Decode(publicIdentitySchema, serializePublicIdentity(identity));
}

export function deserializeFriendshipIdentity(
    identity: Static<typeof publicIdentitySchema>,
): IdentityPublicKeys {
    return deserializePublicIdentity(Value.Decode(publicIdentitySchema, identity));
}

export function serializeFriendshipProfile(
    profile: IdentityProfile,
): Static<typeof storedProfileSchema> {
    validateIdentityProfile(profile);
    const sourceMetadata = profile.metadata ?? {};
    const metadata: Record<string, string> = {};
    if (Value.Check(friendshipMetadataNameSchema, sourceMetadata.firstName)) {
        metadata.firstName = sourceMetadata.firstName;
    }
    if (Value.Check(friendshipMetadataNameSchema, sourceMetadata.lastName)) {
        metadata.lastName = sourceMetadata.lastName;
    }
    const photoHeight = Value.Check(friendshipPhotoDimensionSchema, sourceMetadata.photoHeight)
        ? sourceMetadata.photoHeight
        : undefined;
    const photoMediaType = Value.Check(
        friendshipPhotoMediaTypeSchema,
        sourceMetadata.photoMediaType,
    )
        ? sourceMetadata.photoMediaType
        : undefined;
    const photoThumbhash = Value.Check(
        friendshipPhotoThumbhashSchema,
        sourceMetadata.photoThumbhash,
    )
        ? sourceMetadata.photoThumbhash
        : undefined;
    const photoWidth = Value.Check(friendshipPhotoDimensionSchema, sourceMetadata.photoWidth)
        ? sourceMetadata.photoWidth
        : undefined;
    const height = Number(photoHeight);
    const width = Number(photoWidth);
    const keepPhoto =
        profile.avatar !== undefined &&
        profile.avatar.byteLength <= MAX_MURMUR_PROFILE_PHOTO_BYTES &&
        photoMediaType !== undefined &&
        photoThumbhash !== undefined &&
        Number.isSafeInteger(height) &&
        height >= 1 &&
        height <= 512 &&
        Number.isSafeInteger(width) &&
        width >= 1 &&
        width <= 512;
    if (keepPhoto) {
        metadata.photoHeight = photoHeight!;
        metadata.photoMediaType = photoMediaType;
        metadata.photoThumbhash = photoThumbhash;
        metadata.photoWidth = photoWidth!;
    }
    return Value.Decode(storedProfileSchema, {
        ...(keepPhoto ? { avatar: encodeBase64Url(profile.avatar!) } : {}),
        ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
        name: profile.name,
    });
}

export function deserializeFriendshipProfile(
    profile: Static<typeof storedProfileSchema>,
): IdentityProfile {
    const stored = Value.Decode(storedProfileSchema, profile);
    const native: IdentityProfile = {
        name: stored.name,
        ...(stored.avatar === undefined ? {} : { avatar: decodeBase64Url(stored.avatar) }),
        ...(stored.metadata === undefined ? {} : { metadata: { ...stored.metadata } }),
    };
    try {
        validateIdentityProfile(native);
        return native;
    } catch (error: unknown) {
        if (native.avatar !== undefined) zeroBytes(native.avatar);
        throw error;
    }
}

export function encodeStoredFriendship(friendship: StoredFriendship): Uint8Array {
    return encodeValidated(storedFriendshipSchema, friendship);
}

export function decodeStoredFriendship(bytes: Uint8Array): StoredFriendship {
    return Value.Decode(storedFriendshipSchema, parseJson(bytes));
}

export function encodeStoredFriendshipCount(count: number): Uint8Array {
    return encodeValidated(storedCountSchema, { count, version: 1 });
}

export function decodeStoredFriendshipCount(bytes: Uint8Array): number {
    return Value.Decode(storedCountSchema, parseJson(bytes)).count;
}

export function encodeStoredRelayOutbox(record: {
    readonly event: SignedRelayEvent;
    readonly publishedRelayIds: readonly string[];
}): Uint8Array {
    const wire = encodeSignedRelayEventWire(record.event);
    try {
        return encodeValidated(storedRelayOutboxSchema, {
            event: encodeBase64Url(wire),
            publishedRelayIds: [...record.publishedRelayIds].sort(),
            version: 1,
        });
    } finally {
        zeroBytes(wire);
    }
}

export function decodeStoredRelayOutbox(bytes: Uint8Array): {
    readonly event: SignedRelayEvent;
    readonly publishedRelayIds: readonly string[];
} {
    const stored = Value.Decode(storedRelayOutboxSchema, parseJson(bytes));
    const wire = decodeBase64Url(stored.event);
    try {
        const event = decodeSignedRelayEventWire(wire);
        if (!verifyRelayEvent(event)) {
            zeroBytes(event.author.signingKey);
            zeroBytes(event.payload);
            zeroBytes(event.signature);
            if (event.snapshot?.bytes !== undefined) zeroBytes(event.snapshot.bytes);
            for (const operation of event.list ?? []) {
                if ("bytes" in operation) zeroBytes(operation.bytes);
            }
            throw new Error("Invalid stored friendship relay event");
        }
        return { event, publishedRelayIds: stored.publishedRelayIds };
    } finally {
        zeroBytes(wire);
    }
}

export function encodeStoredGlobalFriendshipEvent(event: StoredGlobalFriendshipEvent): Uint8Array {
    return encodeValidated(storedGlobalEventSchema, event);
}

export function decodeStoredGlobalFriendshipEvent(bytes: Uint8Array): StoredGlobalFriendshipEvent {
    return Value.Decode(storedGlobalEventSchema, parseJson(bytes));
}

export function encodeFriendshipQuarantine(
    bytes: number,
    createdAt: number,
    reason: string,
): Uint8Array {
    return encodeValidated(quarantineSchema, { bytes, createdAt, reason, version: 1 });
}
