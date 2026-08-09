import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function sharingMurmurIdentity(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw("ALTER TABLE sharing_profile_binding ADD COLUMN murmur_identity TEXT"),
    );
}
