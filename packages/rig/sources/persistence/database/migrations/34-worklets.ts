import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * Worklets: background compute installed as versioned source folders.
 *
 * Only the catalog lives here. The imported versions, the icon, and the worklet's own `Data`
 * folder live on disk under the user-visible worklets folder.
 *
 * What a worklet says about itself and what it is allowed to touch belong to the version they
 * arrived with, so they sit on the version row. Reverting therefore restores the older manifest
 * along with the older code, and never leaves a newer grant in force.
 */
export function worklets(database: SessionDatabase): void {
    database.run(
        sql.raw(`
        CREATE TABLE worklets (
            name TEXT NOT NULL PRIMARY KEY,
            author_session_id TEXT NOT NULL,
            source_description TEXT,
            current_version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            icon_thumbhash TEXT NOT NULL
        )
    `),
    );
    database.run(
        sql.raw(`
        CREATE TABLE worklet_versions (
            worklet_name TEXT NOT NULL REFERENCES worklets(name) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            change_description TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            description TEXT NOT NULL,
            permissions_json TEXT NOT NULL,
            PRIMARY KEY (worklet_name, version)
        )
    `),
    );
}
