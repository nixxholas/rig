import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function sharingMurmurIdentity(database: SessionDatabase): void {
    database.run(sql.raw("ALTER TABLE sharing_profile_binding ADD COLUMN murmur_identity TEXT"));
}
