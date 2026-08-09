import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function rigDataIdentityFormat(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`ALTER TABLE rig_data_identity
            ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1 CHECK (format_version = 1)`),
    );
}
