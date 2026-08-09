import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function presenceQuestionDeadlines(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        ALTER TABLE durable_user_inputs
        ADD COLUMN answer_due_at_ms INTEGER
        `),
    );
    await database.run(
        sql.raw(`
        ALTER TABLE durable_user_inputs
        ADD COLUMN answer_wait_started_at_ms INTEGER
    `),
    );
}
