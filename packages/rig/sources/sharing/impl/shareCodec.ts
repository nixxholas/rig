import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    decodeBase64Url,
    decodeEncryptedPrivateMessage,
    deserializePublicIdentity,
    encodeBase64Url,
    encodeEncryptedPrivateMessage,
    MAX_MESSAGE_BYTES,
    serializePublicIdentity,
    utf8Decode,
    utf8Encode,
    zeroBytes,
    type EncryptedPrivateMessage,
    type IdentityPublicKeys,
} from "@slopus/murmur";

const exact = { additionalProperties: false } as const;
const base64UrlSchema = Type.String({
    maxLength: 4 * 1024 * 1024,
    minLength: 1,
    pattern: "^[A-Za-z0-9_-]+$",
});
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const publicIdentitySchema = Type.Object(
    {
        encryptionKey: Type.String({ maxLength: 43, minLength: 43, pattern: "^[A-Za-z0-9_-]+$" }),
        signingKey: Type.String({ maxLength: 43, minLength: 43, pattern: "^[A-Za-z0-9_-]+$" }),
    },
    exact,
);

/**
 * Sent by a friend to offer one fresh one-use MLS KeyPackage to whichever
 * owner later invites them; the private half stays on the offering daemon.
 */
const keyPackageOfferPayloadSchema = Type.Object(
    {
        keyPackage: base64UrlSchema,
        kind: Type.Literal("rig.murmur.share-keypackage.v1"),
        offeredAt: timestampSchema,
        version: Type.Literal(1),
    },
    exact,
);

/** Forwarded verbatim from an owner's `SharedSessionInvitation.text`. */
const invitationForwardPayloadSchema = Type.Object(
    {
        invitationText: Type.String({ maxLength: MAX_MESSAGE_BYTES, minLength: 1 }),
        kind: Type.Literal("rig.murmur.share-invitation.v1"),
        version: Type.Literal(1),
    },
    exact,
);

/**
 * Sent by an owner that wanted to invite a friend but held no unused KeyPackage
 * for them. The friend answers with a fresh offer, which lets the deferred
 * invitation finish without either side polling.
 */
const keyPackageRequestPayloadSchema = Type.Object(
    {
        kind: Type.Literal("rig.murmur.share-keypackage-request.v1"),
        requestedAt: timestampSchema,
        version: Type.Literal(1),
    },
    exact,
);

const sharePrivatePayloadSchema = Type.Union([
    keyPackageOfferPayloadSchema,
    keyPackageRequestPayloadSchema,
    invitationForwardPayloadSchema,
]);

/** Wire envelope carried as a Murmur relay event payload. */
const sharePrivateEnvelopeSchema = Type.Object(
    {
        encrypted: base64UrlSchema,
        kind: Type.Literal("rig.murmur.share-private.v1"),
        version: Type.Literal(1),
    },
    exact,
);

const storedOwnBundleSchema = Type.Object(
    {
        bundle: base64UrlSchema,
        createdAt: timestampSchema,
        version: Type.Literal(1),
    },
    exact,
);

const storedOfferedKeyPackageSchema = Type.Object(
    {
        keyPackage: base64UrlSchema,
        offeredAt: timestampSchema,
        version: Type.Literal(1),
    },
    exact,
);

const storedInvitationSchema = Type.Object(
    {
        invitationText: Type.String({ maxLength: MAX_MESSAGE_BYTES, minLength: 1 }),
        owner: publicIdentitySchema,
        receivedAt: timestampSchema,
        version: Type.Literal(1),
    },
    exact,
);

export type SharePrivatePayload = Static<typeof sharePrivatePayloadSchema>;
export type StoredShareOwnBundle = Static<typeof storedOwnBundleSchema>;
export type StoredShareOfferedKeyPackage = Static<typeof storedOfferedKeyPackageSchema>;
export type StoredShareInvitation = Static<typeof storedInvitationSchema>;

function parseJson(bytes: Uint8Array): unknown {
    return JSON.parse(utf8Decode(bytes)) as unknown;
}

function encodeValidated<Schema extends Parameters<typeof Value.Decode>[0]>(
    schema: Schema,
    value: unknown,
): Uint8Array {
    return utf8Encode(JSON.stringify(Value.Decode(schema, value)));
}

/** Wrap one already-encrypted payload for the wire; throws on an invalid ciphertext shape. */
export function encodeSharePrivateEnvelope(encrypted: EncryptedPrivateMessage): Uint8Array {
    const wire = encodeEncryptedPrivateMessage(encrypted);
    try {
        return encodeValidated(sharePrivateEnvelopeSchema, {
            encrypted: encodeBase64Url(wire),
            kind: "rig.murmur.share-private.v1",
            version: 1,
        });
    } finally {
        zeroBytes(wire);
    }
}

/** Throws for anything that is not a well-formed share-directory envelope. */
export function decodeSharePrivateEnvelope(bytes: Uint8Array): EncryptedPrivateMessage {
    const value = Value.Decode(sharePrivateEnvelopeSchema, parseJson(bytes));
    const wire = decodeBase64Url(value.encrypted);
    try {
        return decodeEncryptedPrivateMessage(wire);
    } finally {
        zeroBytes(wire);
    }
}

export function encodeKeyPackageOfferPayload(
    keyPackageBytes: Uint8Array,
    offeredAt: number,
): string {
    return JSON.stringify(
        Value.Decode(keyPackageOfferPayloadSchema, {
            keyPackage: encodeBase64Url(keyPackageBytes),
            kind: "rig.murmur.share-keypackage.v1",
            offeredAt,
            version: 1,
        }),
    );
}

export function encodeKeyPackageRequestPayload(requestedAt: number): string {
    return JSON.stringify(
        Value.Decode(keyPackageRequestPayloadSchema, {
            kind: "rig.murmur.share-keypackage-request.v1",
            requestedAt,
            version: 1,
        }),
    );
}

export function encodeInvitationForwardPayload(invitationText: string): string {
    return JSON.stringify(
        Value.Decode(invitationForwardPayloadSchema, {
            invitationText,
            kind: "rig.murmur.share-invitation.v1",
            version: 1,
        }),
    );
}

/** Throws for anything that is not a well-formed share-directory message. */
export function decodeSharePrivatePayload(text: string): SharePrivatePayload {
    return Value.Decode(sharePrivatePayloadSchema, JSON.parse(text));
}

export function serializeSharePublicIdentity(
    identity: IdentityPublicKeys,
): Static<typeof publicIdentitySchema> {
    return Value.Decode(publicIdentitySchema, serializePublicIdentity(identity));
}

export function deserializeSharePublicIdentity(
    identity: Static<typeof publicIdentitySchema>,
): IdentityPublicKeys {
    return deserializePublicIdentity(Value.Decode(publicIdentitySchema, identity));
}

export function encodeStoredShareOwnBundle(record: StoredShareOwnBundle): Uint8Array {
    return encodeValidated(storedOwnBundleSchema, record);
}

export function decodeStoredShareOwnBundle(bytes: Uint8Array): StoredShareOwnBundle {
    return Value.Decode(storedOwnBundleSchema, parseJson(bytes));
}

export function encodeStoredShareOfferedKeyPackage(
    record: StoredShareOfferedKeyPackage,
): Uint8Array {
    return encodeValidated(storedOfferedKeyPackageSchema, record);
}

export function decodeStoredShareOfferedKeyPackage(
    bytes: Uint8Array,
): StoredShareOfferedKeyPackage {
    return Value.Decode(storedOfferedKeyPackageSchema, parseJson(bytes));
}

export function encodeStoredShareInvitation(record: StoredShareInvitation): Uint8Array {
    return encodeValidated(storedInvitationSchema, record);
}

export function decodeStoredShareInvitation(bytes: Uint8Array): StoredShareInvitation {
    return Value.Decode(storedInvitationSchema, parseJson(bytes));
}
