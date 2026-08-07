import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * Webapps are now called applets.
 *
 * The imported source folders moved with the rename, from the `Webapps` data folder to `Applets`,
 * so every existing row points at files that are no longer there. This early-stage rename replaces
 * the old tables outright instead of carrying rows that resolve to nothing.
 */
export function applets(database: SessionDatabase): void {
    database.run(sql.raw("DROP TABLE IF EXISTS webapp_versions"));
    database.run(sql.raw("DROP TABLE IF EXISTS webapps"));
    database.run(sql.raw("DROP TABLE IF EXISTS applet_versions"));
    database.run(sql.raw("DROP TABLE IF EXISTS applets"));
    database.run(
        sql.raw(`
        CREATE TABLE applets (
            name TEXT NOT NULL PRIMARY KEY,
            description TEXT NOT NULL,
            purpose TEXT NOT NULL,
            author_session_id TEXT NOT NULL,
            source_description TEXT,
            current_version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            icon_thumbhash TEXT NOT NULL,
            allowed_scopes_json TEXT NOT NULL
        )
    `),
    );
    database.run(
        sql.raw(`
        CREATE TABLE applet_versions (
            applet_name TEXT NOT NULL REFERENCES applets(name) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            change_description TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            PRIMARY KEY (applet_name, version)
        )
    `),
    );
}
