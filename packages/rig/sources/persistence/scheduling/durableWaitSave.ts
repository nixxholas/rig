import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DurableWait } from "../../scheduling/index.js";
import { durableWaits } from "../database/schema.js";

export async function durableWaitSave(ctx: Context, wait: DurableWait): Promise<void> {
    return await inDatabase(ctx, "rig.sql.scheduling.durableWaitSave", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .insert(durableWaits)
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
    });
}
