import { and, eq, ne } from "drizzle-orm";

import type { SharedToolOutput } from "../../session-sharing/SharedToolOutput.js";
import { sessionShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Changes how much of each tool's work a share replicates from now on.
 *
 * Entries already published keep whatever they carried. Lowering the setting
 * therefore stops future disclosure rather than undoing past disclosure, which
 * is the honest shape: a member's copy is theirs once it has been delivered.
 */
export function sessionShareSetToolOutput(
    tx: TX,
    shareId: string,
    toolOutput: SharedToolOutput,
    now: number,
): boolean {
    const result = tx
        .update(sessionShares)
        .set({ toolOutput, updatedAtMs: now })
        .where(
            and(
                eq(sessionShares.shareId, shareId),
                ne(sessionShares.state, "stopped"),
                ne(sessionShares.toolOutput, toolOutput),
            ),
        )
        .run();
    return result.changes > 0;
}
