import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function presenceDetachedQuestions(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        ALTER TABLE durable_user_inputs
        ADD COLUMN detached_at_ms INTEGER
    `),
    );
}
