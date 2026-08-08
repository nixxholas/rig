import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

/**
 * The Unsorted chats that have run out of time, oldest first.
 *
 * Unsorted is a state a chat is started in, recorded as the moment it began belonging nowhere, not
 * merely the absence of a folder: an ordinary project chat has no folder either and must never be
 * swept. Such a chat can file itself while the user talks to it, which clears that moment; one that
 * never does is put away once it has been waiting since before `unsortedBefore`. Only chats of the
 * user's own belong there: a subagent belongs to the session that started it and a delegated chat
 * to the agent that opened it, so neither is ever a candidate. The batch is bounded so one sweep
 * cannot load the whole history.
 */
export function queryExpiredUnsortedSessions(
    tx: TX,
    unsortedBefore: number,
    limit: number,
): readonly string[] {
    return tx
        .all<Record<string, unknown>>(
            sql`
                SELECT id FROM sessions
                WHERE unsorted_since_ms IS NOT NULL
                    AND unsorted_since_ms <= ${unsortedBefore}
                    AND folder_id IS NULL
                    AND archived = 0
                    AND session_kind = 'primary'
                    AND parent_session_id IS NULL
                    AND delegated_by_session_id IS NULL
                ORDER BY unsorted_since_ms ASC, id ASC
                LIMIT ${limit}
            `,
        )
        .map((row) => readString(row, "id"));
}
