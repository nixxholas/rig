import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function projectUserMutationVersion(database: SessionDatabase): void {
    database.run(
        sql.raw("ALTER TABLE projects ADD COLUMN user_mutation_version INTEGER NOT NULL DEFAULT 1"),
    );
    database.run(sql.raw("UPDATE projects SET user_mutation_version = version"));
}
