import { createId } from "@paralleldrive/cuid2";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import tweetnacl from "tweetnacl";

import { p2pInstanceIdSchema, type P2pPeerIdentity } from "../protocol/P2pIdentityProtocol.js";
export {
    p2pInstanceIdSchema,
    p2pPeerIdentitySchema,
    p2pPublicKeySchema,
    type P2pPeerIdentity,
} from "../protocol/P2pIdentityProtocol.js";

export const p2pSecretSeedSchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});

export interface P2pInstanceIdentity extends P2pPeerIdentity {
    sign(message: Uint8Array): string;
}

export function createP2pInstanceIdentity(
    instanceId = createId(),
    secretSeed = tweetnacl.randomBytes(tweetnacl.sign.seedLength),
): P2pInstanceIdentity {
    if (!Value.Check(p2pInstanceIdSchema, instanceId)) {
        throw new Error("The stable P2P instance ID must be a cuid2 identity.");
    }
    if (secretSeed.byteLength !== tweetnacl.sign.seedLength) {
        throw new Error("The P2P identity seed must contain exactly 32 bytes.");
    }
    const keyPair = tweetnacl.sign.keyPair.fromSeed(secretSeed);
    return {
        instanceId,
        publicKey: encodeBase64Url(keyPair.publicKey),
        sign: (message) => encodeBase64Url(tweetnacl.sign.detached(message, keyPair.secretKey)),
    };
}

export function verifyP2pSignature(
    message: Uint8Array,
    signature: string,
    publicKey: string,
): boolean {
    const signatureBytes = decodeBase64Url(signature);
    const publicKeyBytes = decodeBase64Url(publicKey);
    return (
        signatureBytes.byteLength === tweetnacl.sign.signatureLength &&
        publicKeyBytes.byteLength === tweetnacl.sign.publicKeyLength &&
        tweetnacl.sign.detached.verify(message, signatureBytes, publicKeyBytes)
    );
}

export function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64url"));
}
