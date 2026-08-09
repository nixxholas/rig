import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Monotonic owner state survives empty snapshots so credential revocation cannot be replayed. */
export async function p2pCredentialSnapshots(database: SessionDatabase): Promise<void> {
    await database.run(
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
