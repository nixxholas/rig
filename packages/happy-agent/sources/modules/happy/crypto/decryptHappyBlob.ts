import { createHmac } from "node:crypto";

import type { HappyEncryptionVariant } from "../HappyCredentials.js";
import {
    NACL_NONCE_BYTES,
    NACL_SECRETBOX_OVERHEAD_BYTES,
    nobleSecretBoxOpen,
} from "./nobleNaCl.js";

/**
 * Decrypts an attachment Happy stored as a blob.
 *
 * Blobs are always secretbox, under a key derived from the account or session
 * key rather than the key itself.
 */
export function decryptHappyBlob(options: {
    bundle: Uint8Array;
    encryptionKey: Uint8Array;
    encryptionVariant: HappyEncryptionVariant;
}): Uint8Array | undefined {
    const { bundle, encryptionKey, encryptionVariant } = options;
    if (bundle.length < NACL_NONCE_BYTES + NACL_SECRETBOX_OVERHEAD_BYTES) {
        return undefined;
    }
    return nobleSecretBoxOpen(
        bundle.slice(NACL_NONCE_BYTES),
        bundle.slice(0, NACL_NONCE_BYTES),
        deriveBlobKey(encryptionKey, encryptionVariant),
    );
}

function deriveBlobKey(
    encryptionKey: Uint8Array,
    encryptionVariant: HappyEncryptionVariant,
): Uint8Array {
    const root = createHmac("sha512", new TextEncoder().encode("Happy Blobs Master Seed"))
        .update(encryptionKey)
        .digest();
    const path = encryptionVariant === "dataKey" ? "session" : "master";
    return new Uint8Array(
        createHmac("sha512", root.subarray(32))
            .update(new Uint8Array([0, ...new TextEncoder().encode(path)]))
            .digest()
            .subarray(0, 32),
    );
}
