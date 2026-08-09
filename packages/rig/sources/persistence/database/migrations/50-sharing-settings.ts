import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function sharingSettings(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
            CREATE TABLE sharing_settings (
                singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                updated_at_ms INTEGER NOT NULL
            )
        `),
    );
}
