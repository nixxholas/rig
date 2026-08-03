import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function rigDataIdentityFormat(database: SessionDatabase): void {
    database.run(
        sql.raw(`ALTER TABLE rig_data_identity
            ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1 CHECK (format_version = 1)`),
    );
}
