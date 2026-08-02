import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/** Existing webapps keep the original behavior: they may be opened from every slot scope. */
export function webappAllowedScopes(database: SessionDatabase): void {
    database.run(
        sql.raw(`
        ALTER TABLE webapps
        ADD COLUMN allowed_scopes_json TEXT NOT NULL
            DEFAULT '["everywhere","project","workspace","session"]'
    `),
    );
}
