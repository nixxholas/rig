import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function profileGitIdentity(database: SessionDatabase): Promise<void> {
    const profileColumns = await columnNames(database, "rig_profiles");
    if (profileColumns.size > 0 && !profileColumns.has("email")) {
        // Email is now required and cannot be derived honestly from the old display name.
        // Profiles are small, user-created identities, so reset this early-stage catalog
        // explicitly instead of inventing an address or carrying a legacy optional branch.
        await database.run(sql.raw("DROP TABLE rig_profiles"));
        await database.run(
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
        await database.run(
            sql.raw(
                "CREATE INDEX rig_profiles_parent_instance ON rig_profiles (parent_instance_id, id)",
            ),
        );
    }
    const sessionColumns = await columnNames(database, "sessions");
    if (sessionColumns.size > 0 && !sessionColumns.has("profile_id")) {
        await database.run(sql.raw("ALTER TABLE sessions ADD COLUMN profile_id TEXT"));
    }
}

async function columnNames(
    database: SessionDatabase,
    table: "rig_profiles" | "sessions",
): Promise<Set<string>> {
    return new Set(
        (await database.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))).map(
            (column) => column.name,
        ),
    );
}
