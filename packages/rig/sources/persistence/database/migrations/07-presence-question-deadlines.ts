import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function presenceQuestionDeadlines(database: SessionDatabase): void {
    database.run(
        sql.raw(`
        ALTER TABLE durable_user_inputs
        ADD COLUMN answer_due_at_ms INTEGER
        `),
    );
    database.run(
        sql.raw(`
        ALTER TABLE durable_user_inputs
        ADD COLUMN answer_wait_started_at_ms INTEGER
    `),
    );
}
