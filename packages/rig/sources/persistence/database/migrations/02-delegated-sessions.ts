import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

const statements = [
    "ALTER TABLE sessions ADD COLUMN delegated_by_session_id TEXT",
    "CREATE INDEX sessions_delegated_by ON sessions(delegated_by_session_id)",
] as const;

/**
 * A delegated session is a visible conversation another session started for it. It keeps its own
 * place in the session list, so the delegator is recorded beside the session rather than as a
 * subagent parent.
 */
export async function delegatedSessions(database: SessionDatabase): Promise<void> {
    for (const statement of statements) await database.run(sql.raw(statement));
}
