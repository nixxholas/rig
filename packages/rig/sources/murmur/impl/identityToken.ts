import {
    decodeBase64Url,
    encodeBase64Url,
    zeroBytes,
    type IdentityPublicKeys,
} from "@slopus/murmur";

const IDENTITY_TOKEN_PART = /^[A-Za-z0-9_-]{43}$/u;

/** Encode both Murmur public identity keys as the strict CLI-compatible token. */
export function encodeMurmurIdentityToken(identity: IdentityPublicKeys): string {
    if (identity.signingKey.length !== 32 || identity.encryptionKey.length !== 32) {
        throw new Error("Murmur identity public keys must be 32 bytes");
    }
    return `${encodeBase64Url(identity.signingKey)}.${encodeBase64Url(identity.encryptionKey)}`;
}

/** Decode a canonical Murmur public identity token. */
export function decodeMurmurIdentityToken(token: string): IdentityPublicKeys {
    const parts = token.split(".");
    if (
        parts.length !== 2 ||
        !IDENTITY_TOKEN_PART.test(parts[0] ?? "") ||
        !IDENTITY_TOKEN_PART.test(parts[1] ?? "")
    ) {
        throw new Error("Invalid Murmur identity token");
    }
    const signingKey = decodeBase64Url(parts[0]!);
    const encryptionKey = decodeBase64Url(parts[1]!);
    if (
        signingKey.length !== 32 ||
        encryptionKey.length !== 32 ||
        encodeBase64Url(signingKey) !== parts[0] ||
        encodeBase64Url(encryptionKey) !== parts[1]
    ) {
        zeroBytes(signingKey);
        zeroBytes(encryptionKey);
        throw new Error("Invalid Murmur identity token");
    }
    return { signingKey, encryptionKey };
}
