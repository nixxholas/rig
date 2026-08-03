import { eq } from "drizzle-orm";

import { sessionShareMessageContext } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { SessionShareMessageDisposition } from "./types.js";

export function sessionShareMessageContextSet(
    tx: TX,
    input: {
        disposition: SessionShareMessageDisposition;
        includedRunId?: string;
        messageId: string;
        now: number;
    },
): boolean {
    if (input.disposition === "included" && input.includedRunId === undefined) {
        throw new Error("Included friend messages require a run ID.");
    }
    const result = tx
        .update(sessionShareMessageContext)
        .set({
            disposition: input.disposition,
            includedRunId: input.disposition === "included" ? (input.includedRunId ?? null) : null,
            updatedAtMs: input.now,
        })
        .where(eq(sessionShareMessageContext.messageId, input.messageId))
        .run();
    return result.changes > 0;
}
