import { sql } from "drizzle-orm";

import type { DurableWait } from "../../scheduling/index.js";
import { durableWaits } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function durableWaitSave(tx: TX, wait: DurableWait): void {
    tx.insert(durableWaits)
        .values({
            argumentsJson: JSON.stringify(wait.arguments),
            batchId: wait.batchId,
            consumed: wait.consumed,
            createdAtMs: wait.createdAt,
            dueAtMs: wait.dueAt,
            id: wait.id,
            kind: wait.kind,
            providerToolCallId: wait.providerToolCallId ?? null,
            resultBlockJson:
                wait.resultBlock === undefined ? null : JSON.stringify(wait.resultBlock),
            resultJson: wait.result === undefined ? null : JSON.stringify(wait.result),
            runId: wait.runId,
            sessionId: wait.sessionId,
            status: wait.status,
            toolCallId: wait.toolCallId,
            toolCallIndex: wait.toolCallIndex,
            toolName: wait.toolName,
        })
        .onConflictDoUpdate({
            set: {
                consumed: sql`excluded.consumed`,
                resultBlockJson: sql`excluded.result_block_json`,
                resultJson: sql`excluded.result_json`,
                status: sql`excluded.status`,
            },
            target: durableWaits.id,
        })
        .run();
}
