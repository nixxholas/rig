import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function presenceDetachedQuestions(database: SessionDatabase): void {
    database.run(
        sql.raw(`
        ALTER TABLE durable_user_inputs
        ADD COLUMN detached_at_ms INTEGER
    `),
    );
}
