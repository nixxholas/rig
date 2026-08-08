import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/** Bounded durable receipts for session mutations whose HTTP response may be lost. */
export function sessionMutations(database: SessionDatabase): void {
    database.run(
        sql.raw(`
        CREATE TABLE session_mutations (
            mutation_id TEXT NOT NULL PRIMARY KEY,
            action TEXT NOT NULL,
            session_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        )
    `),
    );
    database.run(
        sql.raw(
            "CREATE INDEX session_mutations_created ON session_mutations(created_at_ms DESC, mutation_id DESC)",
        ),
    );
}
