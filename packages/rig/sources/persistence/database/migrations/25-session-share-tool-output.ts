import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/**
 * How much of each tool's work a share replicates.
 *
 * Shares created before this column existed were publishing raw tool output, so
 * the default is deliberately the private setting rather than the behavior they
 * had: an owner who never asked for full output should stop sending it.
 */
export function sessionShareToolOutput(database: SessionDatabase): void {
    database.run(
        sql.raw(
            `ALTER TABLE session_shares
             ADD COLUMN tool_output TEXT NOT NULL DEFAULT 'summaries'`,
        ),
    );
}
