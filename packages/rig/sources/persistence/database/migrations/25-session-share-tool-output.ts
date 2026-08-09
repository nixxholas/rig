import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * How much of each tool's work a share replicates.
 *
 * Shares created before this column existed were publishing raw tool output, so
 * the default is deliberately the private setting rather than the behavior they
 * had: an owner who never asked for full output should stop sending it.
 */
export async function sessionShareToolOutput(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(
            `ALTER TABLE session_shares
             ADD COLUMN tool_output TEXT NOT NULL DEFAULT 'summaries'`,
        ),
    );
}
