import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Existing webapps keep the original behavior: they may be opened from every slot scope. */
export async function webappAllowedScopes(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        ALTER TABLE webapps
        ADD COLUMN allowed_scopes_json TEXT NOT NULL
            DEFAULT '["everywhere","project","workspace","session"]'
    `),
    );
}
