import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * Webapp identity icons are stored on disk and their ThumbHash stays with the webapp row.
 *
 * Existing webapps predate required icons and cannot satisfy the new contract, so this early-stage
 * schema change discards only those records instead of manufacturing invalid metadata.
 */
export async function webappIcons(database: SessionDatabase): Promise<void> {
    await database.run(sql.raw("DELETE FROM webapp_versions"));
    await database.run(sql.raw("DELETE FROM webapps"));
    await database.run(
        sql.raw(`
        ALTER TABLE webapps
        ADD COLUMN icon_thumbhash TEXT NOT NULL DEFAULT ''
    `),
    );
}
