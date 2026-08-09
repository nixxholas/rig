import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function sharingSettings(database: SessionDatabase): void {
    database.run(
        sql.raw(`
            CREATE TABLE sharing_settings (
                singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                updated_at_ms INTEGER NOT NULL
            )
        `),
    );
}
