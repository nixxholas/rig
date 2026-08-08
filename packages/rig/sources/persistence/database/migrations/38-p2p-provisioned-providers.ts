import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * Provider credentials supplied by a trusted P2P peer.
 *
 * A snapshot belongs to its authenticated owner, rather than to a provider
 * globally: more than one owner may provision the same provider ID without
 * either credential replacing the other.
 */
export function p2pProvisionedProviders(database: SessionDatabase): void {
    database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS p2p_provisioned_providers (
                owner_instance_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                public_config_json TEXT NOT NULL,
                encrypted_material_json TEXT,
                source_digest TEXT NOT NULL,
                visibility TEXT NOT NULL,
                position INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (owner_instance_id, provider_id)
            )
        `),
    );
    database.run(
        sql.raw(
            "CREATE INDEX IF NOT EXISTS p2p_provisioned_providers_owner_position ON p2p_provisioned_providers (owner_instance_id, position, provider_id)",
        ),
    );
}
