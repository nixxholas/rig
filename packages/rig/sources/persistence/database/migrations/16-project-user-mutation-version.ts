import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function projectUserMutationVersion(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw("ALTER TABLE projects ADD COLUMN user_mutation_version INTEGER NOT NULL DEFAULT 1"),
    );
    await database.run(sql.raw("UPDATE projects SET user_mutation_version = version"));
}
