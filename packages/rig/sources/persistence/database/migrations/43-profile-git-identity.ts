import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function profileGitIdentity(database: SessionDatabase): void {
    const profileColumns = columnNames(database, "rig_profiles");
    if (profileColumns.size > 0 && !profileColumns.has("email")) {
        // Email is now required and cannot be derived honestly from the old display name.
        // Profiles are small, user-created identities, so reset this early-stage catalog
        // explicitly instead of inventing an address or carrying a legacy optional branch.
        database.run(sql.raw("DROP TABLE rig_profiles"));
        database.run(
            sql.raw(`CREATE TABLE rig_profiles (
                id TEXT NOT NULL PRIMARY KEY,
                parent_instance_id TEXT NOT NULL,
                name TEXT NOT NULL,
                photo_json TEXT,
                version INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                email TEXT NOT NULL
            )`),
        );
        database.run(
            sql.raw(
                "CREATE INDEX rig_profiles_parent_instance ON rig_profiles (parent_instance_id, id)",
            ),
        );
    }
    const sessionColumns = columnNames(database, "sessions");
    if (sessionColumns.size > 0 && !sessionColumns.has("profile_id")) {
        database.run(sql.raw("ALTER TABLE sessions ADD COLUMN profile_id TEXT"));
    }
}

function columnNames(database: SessionDatabase, table: "rig_profiles" | "sessions"): Set<string> {
    return new Set(
        database
            .all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))
            .map((column) => column.name),
    );
}
