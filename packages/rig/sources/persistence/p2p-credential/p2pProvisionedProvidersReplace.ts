import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import type { DatabaseScope } from "../Transaction.js";
import { p2pProvisionedProviders } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { p2pInstanceIdSchema } from "../../protocol/P2pIdentityProtocol.js";
import {
    p2pProvisionedProviderRecordSchema,
    type P2pProvisionedProviderRecord,
} from "./P2pProvisionedProviderRecord.js";
import { queryP2pProvisionedProviders } from "./queryP2pProvisionedProviders.js";

/**
 * Replaces a single authenticated owner's complete provider snapshot.
 *
 * The owner predicate is present on the delete, so a successful replacement
 * cannot remove credentials supplied by another trusted Rig.
 */
export async function p2pProvisionedProvidersReplace(
    tx: DatabaseScope,
    ownerInstanceId: string,
    providers: readonly P2pProvisionedProviderRecord[],
): Promise<boolean> {
    if (!Value.Check(p2pInstanceIdSchema, ownerInstanceId)) {
        throw new Error("The authenticated P2P credential owner is invalid.");
    }
    if (providers.some((provider) => provider.ownerInstanceId !== ownerInstanceId)) {
        throw new Error("A provisioned provider does not belong to its authenticated owner.");
    }
    if (!providers.every((provider) => Value.Check(p2pProvisionedProviderRecordSchema, provider))) {
        throw new Error("The P2P provisioned provider is invalid.");
    }
    const providerIds = new Set(providers.map((provider) => provider.providerId));
    if (providerIds.size !== providers.length) {
        throw new Error("A P2P credential snapshot cannot contain a provider more than once.");
    }
    const sourceDigest = providers[0]?.sourceDigest;
    if (
        sourceDigest !== undefined &&
        providers.some((provider) => provider.sourceDigest !== sourceDigest)
    ) {
        throw new Error("A P2P credential snapshot must use one source digest.");
    }
    return await inTx(tx, async (transaction) => {
        const current = await queryP2pProvisionedProviders(transaction, ownerInstanceId);
        if (
            current.length === providers.length &&
            current.length > 0 &&
            current.every((provider) => provider.sourceDigest === sourceDigest)
        ) {
            return false;
        }
        if (current.length === 0 && providers.length === 0) return false;
        await transaction
            .delete(p2pProvisionedProviders)
            .where(eq(p2pProvisionedProviders.ownerInstanceId, ownerInstanceId))
            .run();
        if (providers.length > 0) {
            await transaction
                .insert(p2pProvisionedProviders)
                .values(
                    providers.map((provider) => ({
                        createdAtMs: provider.createdAt,
                        encryptedMaterialJson: provider.encryptedMaterialJson,
                        ownerInstanceId: provider.ownerInstanceId,
                        position: provider.position,
                        providerId: provider.providerId,
                        publicConfigJson: provider.publicConfigJson,
                        sourceDigest: provider.sourceDigest,
                        updatedAtMs: provider.updatedAt,
                        visibility: provider.visibility,
                    })),
                )
                .run();
        }
        return true;
    });
}
