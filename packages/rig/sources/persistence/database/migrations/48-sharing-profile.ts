import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function sharingProfile(database: SessionDatabase): void {
    database.run(
        sql.raw(`
            CREATE TABLE sharing_profile_binding (
                singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
                profile_id TEXT NOT NULL UNIQUE REFERENCES rig_profiles(id) ON DELETE RESTRICT,
                created_at_ms INTEGER NOT NULL
            )
        `),
    );
}
