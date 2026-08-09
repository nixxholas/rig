import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function projectComputeGeneration(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(
            "ALTER TABLE projects ADD COLUMN default_compute_generation INTEGER NOT NULL DEFAULT 0",
        ),
    );
    await database.run(
        sql.raw(
            "UPDATE projects SET default_compute_generation = 1 WHERE default_compute IS NOT NULL",
        ),
    );
}
