import { Type, type Static } from "@sinclair/typebox";

import { p2pInstanceIdSchema } from "../../protocol/P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;

export const p2pProvisionedProviderVisibilitySchema = Type.Union([
    Type.Literal("owner_only"),
    Type.Literal("shared"),
]);
export type P2pProvisionedProviderVisibility = Static<
    typeof p2pProvisionedProviderVisibilitySchema
>;

/**
 * The encrypted material is opaque to persistence. It is authenticated and
 * decoded by P2pCredentialStore before becoming executable provider material.
 */
export const p2pProvisionedProviderRecordSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        encryptedMaterialJson: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        ownerInstanceId: p2pInstanceIdSchema,
        position: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        providerId: Type.String({ maxLength: 256, minLength: 1 }),
        publicConfigJson: Type.String({ minLength: 1 }),
        sourceDigest: Type.String({
            maxLength: 64,
            minLength: 64,
            pattern: "^[a-f0-9]{64}$",
        }),
        updatedAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        visibility: p2pProvisionedProviderVisibilitySchema,
    },
    exact,
);
export type P2pProvisionedProviderRecord = Static<typeof p2pProvisionedProviderRecordSchema>;
