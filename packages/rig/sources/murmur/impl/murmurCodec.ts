import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    decodeBase64Url,
    decodeSignedRelayEventWire,
    destroyIdentity,
    encodeBase64Url,
    encodeSignedRelayEventWire,
    importIdentityKeyPair,
    utf8Decode,
    utf8Encode,
    validateIdentityProfile,
    verifyRelayEvent,
    zeroBytes,
    type EncryptedProfile,
    type IdentityProfile,
    type IdentityPublicKeys,
    type OpenedProfile,
    type SignedRelayEvent,
} from "@slopus/murmur";

import type { MurmurPhoto, MurmurProfile } from "../../protocol/MurmurProtocol.js";
import type { StoredMurmurAccount } from "../types.js";

const exact = { additionalProperties: false } as const;
const base64UrlSchema = Type.String({
    maxLength: 2 * 1024 * 1024,
    minLength: 1,
    pattern: "^[A-Za-z0-9_-]+$",
});
const publicIdentitySchema = Type.Object(
    {
        encryptionKey: base64UrlSchema,
        signingKey: base64UrlSchema,
    },
    exact,
);
const storedPhotoSchema = Type.Object(
    {
        data: base64UrlSchema,
        height: Type.Integer({ maximum: 512, minimum: 1 }),
        thumbhash: Type.String({ maxLength: 1_024, minLength: 1 }),
        width: Type.Integer({ maximum: 512, minimum: 1 }),
    },
    exact,
);
const storedProfileSchema = Type.Object(
    {
        firstName: Type.String({ maxLength: 128, minLength: 1 }),
        lastName: Type.String({ maxLength: 128, minLength: 1 }),
        photo: Type.Optional(storedPhotoSchema),
    },
    exact,
);
const storedAccountSchema = Type.Object(
    {
        encryptionSecretKey: base64UrlSchema,
        profile: storedProfileSchema,
        signingSecretKey: base64UrlSchema,
        version: Type.Literal(1),
    },
    exact,
);
const encryptedProfileSchema = Type.Object(
    {
        ciphertext: base64UrlSchema,
        ephemeralPublicKey: base64UrlSchema,
        nonce: base64UrlSchema,
        recipient: base64UrlSchema,
        version: Type.Literal(1),
    },
    exact,
);
const profileEnvelopeSchema = Type.Object(
    {
        encrypted: encryptedProfileSchema,
        kind: Type.Literal("rig.murmur.friend-request.v1"),
    },
    exact,
);
const handledEnvelopeSchema = Type.Object(
    {
        kind: Type.Literal("rig.murmur.friend-request-handled.v1"),
        requestId: Type.String({ maxLength: 256, minLength: 1 }),
    },
    exact,
);
const pendingRequestSchema = Type.Object(
    {
        id: Type.String({ maxLength: 256, minLength: 1 }),
        identity: publicIdentitySchema,
        profile: storedProfileSchema,
        receivedAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        version: Type.Literal(1),
    },
    exact,
);
const handledRequestSchema = Type.Object(
    {
        answer: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
        answeredAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        version: Type.Literal(1),
    },
    exact,
);
const pendingRequestCountSchema = Type.Integer({ maximum: 1_000, minimum: 0 });
const outboundEventSchema = Type.Object(
    {
        event: Type.String({
            maxLength: 4 * 1024 * 1024,
            minLength: 1,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
        publishedRelayIds: Type.Array(Type.String({ maxLength: 128, minLength: 1 }), {
            maxItems: 16,
            uniqueItems: true,
        }),
        version: Type.Literal(1),
    },
    exact,
);
const nativeMetadataSchema = Type.Object(
    {
        firstName: Type.String({ maxLength: 128, minLength: 1 }),
        lastName: Type.String({ maxLength: 128, minLength: 1 }),
        photoHeight: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,3}$" })),
        photoMediaType: Type.Optional(Type.Literal("image/webp")),
        photoThumbhash: Type.Optional(Type.String({ maxLength: 1_024, minLength: 1 })),
        photoWidth: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,3}$" })),
    },
    exact,
);

type StoredProfile = Static<typeof storedProfileSchema>;
type StoredOutboundEventWire = Static<typeof outboundEventSchema>;
export type StoredHandledRequest = Static<typeof handledRequestSchema>;
export type StoredPendingRequest = Static<typeof pendingRequestSchema>;

function parseJson(bytes: Uint8Array): unknown {
    return JSON.parse(utf8Decode(bytes)) as unknown;
}

function storedProfileToNative(profile: StoredProfile): IdentityProfile {
    const photo = profile.photo;
    const avatar = photo === undefined ? undefined : decodeBase64Url(photo.data);
    const metadata: Record<string, string> = {
        firstName: profile.firstName,
        lastName: profile.lastName,
    };
    if (photo !== undefined) {
        metadata.photoHeight = String(photo.height);
        metadata.photoMediaType = "image/webp";
        metadata.photoThumbhash = photo.thumbhash;
        metadata.photoWidth = String(photo.width);
    }
    const native = {
        name: `${profile.firstName} ${profile.lastName}`,
        ...(avatar === undefined ? {} : { avatar }),
        metadata,
    };
    validateIdentityProfile(native);
    return native;
}

export function publicProfileToStored(profile: MurmurProfile): StoredProfile {
    let photoData: Uint8Array | undefined;
    if (profile.photo !== undefined) {
        photoData = Buffer.from(profile.photo.data, "base64");
    }
    try {
        return {
            firstName: profile.firstName,
            lastName: profile.lastName,
            ...(profile.photo === undefined
                ? {}
                : {
                      photo: {
                          data: encodeBase64Url(photoData!),
                          height: profile.photo.height,
                          thumbhash: profile.photo.thumbhash,
                          width: profile.photo.width,
                      },
                  }),
        };
    } finally {
        if (photoData !== undefined) zeroBytes(photoData);
    }
}

export function nativeProfileToPublic(profile: IdentityProfile): MurmurProfile {
    const metadata = Value.Decode(nativeMetadataSchema, profile.metadata);
    const hasPhotoMetadata =
        metadata.photoHeight !== undefined ||
        metadata.photoMediaType !== undefined ||
        metadata.photoThumbhash !== undefined ||
        metadata.photoWidth !== undefined;
    if (profile.avatar === undefined && hasPhotoMetadata) {
        throw new Error("Murmur profile photo metadata has no avatar");
    }
    if (
        profile.avatar !== undefined &&
        (metadata.photoHeight === undefined ||
            metadata.photoMediaType === undefined ||
            metadata.photoThumbhash === undefined ||
            metadata.photoWidth === undefined)
    ) {
        throw new Error("Murmur profile avatar metadata is incomplete");
    }
    let photo: MurmurPhoto | undefined;
    if (profile.avatar !== undefined) {
        const width = Number(metadata.photoWidth);
        const height = Number(metadata.photoHeight);
        if (width > 512 || height > 512) {
            throw new Error("Murmur profile photo dimensions are invalid");
        }
        photo = {
            bytes: profile.avatar.byteLength,
            data: Buffer.from(profile.avatar).toString("base64"),
            height,
            mediaType: "image/webp",
            thumbhash: metadata.photoThumbhash!,
            width,
        };
    }
    return {
        firstName: metadata.firstName,
        lastName: metadata.lastName,
        ...(photo === undefined ? {} : { photo }),
    };
}

export function publicProfileToNative(profile: MurmurProfile): IdentityProfile {
    return storedProfileToNative(publicProfileToStored(profile));
}

/** Encode one durable account, including its two secret identity seeds. */
export function encodeStoredMurmurAccount(account: StoredMurmurAccount): Uint8Array {
    const profile = nativeProfileToPublic(account.profile);
    return utf8Encode(
        JSON.stringify({
            version: 1,
            signingSecretKey: encodeBase64Url(account.identity.signingSecretKey),
            encryptionSecretKey: encodeBase64Url(account.identity.encryptionSecretKey),
            profile: publicProfileToStored(profile),
        }),
    );
}

/** Decode and cryptographically reconstruct one durable account. */
export function decodeStoredMurmurAccount(bytes: Uint8Array): StoredMurmurAccount {
    const stored = Value.Decode(storedAccountSchema, parseJson(bytes));
    let signingSecretKey: Uint8Array | undefined;
    let encryptionSecretKey: Uint8Array | undefined;
    let profile: IdentityProfile | undefined;
    try {
        signingSecretKey = decodeBase64Url(stored.signingSecretKey);
        encryptionSecretKey = decodeBase64Url(stored.encryptionSecretKey);
        profile = storedProfileToNative(stored.profile);
        const identity = importIdentityKeyPair(signingSecretKey, encryptionSecretKey);
        return { identity, profile };
    } catch (error: unknown) {
        if (profile?.avatar !== undefined) zeroBytes(profile.avatar);
        throw error;
    } finally {
        if (signingSecretKey !== undefined) zeroBytes(signingSecretKey);
        if (encryptionSecretKey !== undefined) zeroBytes(encryptionSecretKey);
    }
}

export function destroyStoredMurmurAccount(account: StoredMurmurAccount): void {
    destroyIdentity(account.identity);
    if (account.profile.avatar !== undefined) zeroBytes(account.profile.avatar);
}

export function encodeFriendRequestEnvelope(encrypted: EncryptedProfile): Uint8Array {
    return utf8Encode(
        JSON.stringify({
            kind: "rig.murmur.friend-request.v1",
            encrypted,
        }),
    );
}

export function decodeFriendRequestEnvelope(bytes: Uint8Array): EncryptedProfile {
    return Value.Decode(profileEnvelopeSchema, parseJson(bytes)).encrypted;
}

export function encodeHandledRequestEnvelope(requestId: string): Uint8Array {
    return utf8Encode(
        JSON.stringify(
            Value.Decode(handledEnvelopeSchema, {
                kind: "rig.murmur.friend-request-handled.v1",
                requestId,
            }),
        ),
    );
}

export function isHandledRequestEnvelope(bytes: Uint8Array): boolean {
    try {
        Value.Decode(handledEnvelopeSchema, parseJson(bytes));
        return true;
    } catch {
        return false;
    }
}

export function encodeStoredPendingRequest(request: StoredPendingRequest): Uint8Array {
    return utf8Encode(JSON.stringify(Value.Decode(pendingRequestSchema, request)));
}

export function decodeStoredPendingRequest(bytes: Uint8Array): StoredPendingRequest {
    return Value.Decode(pendingRequestSchema, parseJson(bytes));
}

export function encodeStoredHandledRequest(request: StoredHandledRequest): Uint8Array {
    return utf8Encode(JSON.stringify(Value.Decode(handledRequestSchema, request)));
}

export function decodeStoredHandledRequest(bytes: Uint8Array): StoredHandledRequest {
    return Value.Decode(handledRequestSchema, parseJson(bytes));
}

export function encodeStoredPendingRequestCount(count: number): Uint8Array {
    return utf8Encode(JSON.stringify(Value.Decode(pendingRequestCountSchema, count)));
}

export function decodeStoredPendingRequestCount(bytes: Uint8Array): number {
    return Value.Decode(pendingRequestCountSchema, parseJson(bytes));
}

export function encodeStoredOutboundEvent(record: {
    readonly event: SignedRelayEvent;
    readonly publishedRelayIds: readonly string[];
}): Uint8Array {
    const event = encodeSignedRelayEventWire(record.event);
    try {
        return utf8Encode(
            JSON.stringify(
                Value.Decode(outboundEventSchema, {
                    event: encodeBase64Url(event),
                    publishedRelayIds: [...record.publishedRelayIds].sort(),
                    version: 1,
                }),
            ),
        );
    } finally {
        zeroBytes(event);
    }
}

export function decodeStoredOutboundEvent(bytes: Uint8Array) {
    const stored: StoredOutboundEventWire = Value.Decode(outboundEventSchema, parseJson(bytes));
    const eventBytes = decodeBase64Url(stored.event);
    try {
        const event = decodeSignedRelayEventWire(eventBytes);
        if (!verifyRelayEvent(event)) throw new Error("Invalid stored Murmur outbound event");
        return { event, publishedRelayIds: stored.publishedRelayIds };
    } finally {
        zeroBytes(eventBytes);
    }
}

export function openedProfileToPending(
    id: string,
    opened: OpenedProfile,
    receivedAt: number,
): StoredPendingRequest {
    return Value.Decode(pendingRequestSchema, {
        id,
        identity: {
            encryptionKey: encodeBase64Url(opened.identity.encryptionKey),
            signingKey: encodeBase64Url(opened.identity.signingKey),
        },
        profile: publicProfileToStored(nativeProfileToPublic(opened.profile)),
        receivedAt,
        version: 1,
    });
}

export function pendingToOpened(request: StoredPendingRequest): OpenedProfile {
    const identity = decodeStoredPublicIdentity(request.identity);
    try {
        return {
            identity,
            profile: storedProfileToNative(request.profile),
        };
    } catch (error: unknown) {
        zeroBytes(identity.signingKey);
        zeroBytes(identity.encryptionKey);
        throw error;
    }
}

export function decodeStoredPublicIdentity(
    identity: Static<typeof publicIdentitySchema>,
): IdentityPublicKeys {
    let signingKey: Uint8Array | undefined;
    let encryptionKey: Uint8Array | undefined;
    try {
        signingKey = decodeBase64Url(identity.signingKey);
        encryptionKey = decodeBase64Url(identity.encryptionKey);
        if (signingKey.length !== 32 || encryptionKey.length !== 32) {
            throw new Error("Invalid Murmur public identity");
        }
        return { signingKey, encryptionKey };
    } catch (error: unknown) {
        if (signingKey !== undefined) zeroBytes(signingKey);
        if (encryptionKey !== undefined) zeroBytes(encryptionKey);
        throw error;
    }
}
