import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { readOptionalString, readString } from "./impl/sqliteRow.js";

export interface InterruptedSessionCandidate {
    activeRunId?: string;
    sessionId: string;
}

export async function queryInterruptedSessionCandidates(
    tx: DatabaseScope,
): Promise<readonly InterruptedSessionCandidate[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT DISTINCT sessions.id, sessions.active_run_id
            FROM sessions
            LEFT JOIN queued_runs ON queued_runs.session_id = sessions.id
            WHERE sessions.status IN ('queued', 'running')
                OR sessions.active_run_id IS NOT NULL
                OR queued_runs.run_id IS NOT NULL
        `)
        ).map((row) => {
            const activeRunId = readOptionalString(row, "active_run_id");
            return {
                ...(activeRunId === undefined ? {} : { activeRunId }),
                sessionId: readString(row, "id"),
            };
        });
    });
}
