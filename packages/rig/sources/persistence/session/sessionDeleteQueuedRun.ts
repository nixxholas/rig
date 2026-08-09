import { inDatabase } from "../database/inDatabase.js";
import { and, eq } from "drizzle-orm";

import { queuedRuns } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function sessionDeleteQueuedRun(
    tx: DatabaseScope,
    sessionId: string,
    runId: string,
): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .delete(queuedRuns)
            .where(and(eq(queuedRuns.sessionId, sessionId), eq(queuedRuns.runId, runId)))
            .run();
    });
}
