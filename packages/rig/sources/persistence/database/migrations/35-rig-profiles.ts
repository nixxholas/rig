import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function rigProfiles(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`CREATE TABLE rig_profiles (
            id TEXT NOT NULL PRIMARY KEY,
            parent_instance_id TEXT NOT NULL,
            name TEXT NOT NULL,
            photo_json TEXT,
            version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )`),
    );
    await database.run(
        sql.raw(
            "CREATE INDEX rig_profiles_parent_instance ON rig_profiles (parent_instance_id, id)",
        ),
    );
}
