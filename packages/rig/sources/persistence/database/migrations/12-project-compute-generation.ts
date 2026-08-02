import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function projectComputeGeneration(database: SessionDatabase): void {
    database.run(
        sql.raw(
            "ALTER TABLE projects ADD COLUMN default_compute_generation INTEGER NOT NULL DEFAULT 0",
        ),
    );
    database.run(
        sql.raw(
            "UPDATE projects SET default_compute_generation = 1 WHERE default_compute IS NOT NULL",
        ),
    );
}
