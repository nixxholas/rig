import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function sharingProfile(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
            CREATE TABLE sharing_profile_binding (
                singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
                profile_id TEXT NOT NULL UNIQUE REFERENCES rig_profiles(id) ON DELETE RESTRICT,
                created_at_ms INTEGER NOT NULL
            )
        `),
    );
}
