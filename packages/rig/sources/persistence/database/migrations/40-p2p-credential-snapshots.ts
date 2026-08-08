import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/** Monotonic owner state survives empty snapshots so credential revocation cannot be replayed. */
export function p2pCredentialSnapshots(database: SessionDatabase): void {
    database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS p2p_credential_snapshots (
                owner_instance_id TEXT PRIMARY KEY NOT NULL,
                version INTEGER NOT NULL,
                source_digest TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            )
        `),
    );
}
