import { and, eq } from "drizzle-orm";

import { queuedRuns } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function sessionDeleteQueuedRun(tx: TX, sessionId: string, runId: string): void {
    tx.delete(queuedRuns)
        .where(and(eq(queuedRuns.sessionId, sessionId), eq(queuedRuns.runId, runId)))
        .run();
}
