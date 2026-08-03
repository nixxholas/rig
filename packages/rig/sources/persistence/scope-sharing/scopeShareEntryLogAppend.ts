import { and, eq } from "drizzle-orm";

import type { ScopeShareSubjectKind } from "../../scope-sharing/projectScopeShareEntry.js";
import type { ShareOpaqueEntry } from "../../sharing/ShareTransport.js";
import { scopeShareEntries } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export interface ScopeShareLoggedEntry extends ShareOpaqueEntry {
    readonly subjectId: string;
    readonly subjectKind: ScopeShareSubjectKind;
}

/**
 * Retain one share's acknowledged entries as the history a later member is offered.
 *
 * The log is kept whole and never truncated. Murmur requires a history offer to be
 * strictly contiguous from the sequence a member asks after — it raises
 * `sequence-gap` on the first page that is not — so removing any entry, however
 * redundant its content, would permanently break every later member's catch-up.
 * Nothing here is ever superseded or pruned early, and neither is the outbox, whose
 * rows already carry the sequences a member will be offered. Redundancy is instead
 * prevented upstream: a cursor emits a `session_index` entry only once the session
 * row it describes has actually changed, so a fact identical to the last one is
 * never written in the first place. The log's retention is the share's own lifetime:
 * `scopeShareEntryLogPrune` drops it whole when the share stops.
 */
export function scopeShareEntryLogAppend(
    tx: TX,
    input: { entries: readonly ScopeShareLoggedEntry[]; shareId: string },
): void {
    if (input.entries.length === 0) return;
    inTx(tx, (tx) => {
        for (const entry of input.entries) {
            if (entry.shareId !== input.shareId) {
                throw new Error("The shared scope entry does not belong to this share.");
            }
            const existing = tx
                .select()
                .from(scopeShareEntries)
                .where(
                    and(
                        eq(scopeShareEntries.shareId, input.shareId),
                        eq(scopeShareEntries.sequence, entry.shareSequence),
                    ),
                )
                .get();
            if (existing !== undefined) {
                if (existing.contentHash === entry.contentHash) continue;
                throw new Error(
                    `Shared scope entry ${String(entry.shareSequence)} for share ${input.shareId} already has different content.`,
                );
            }
            tx.insert(scopeShareEntries)
                .values({
                    byteLength: Buffer.byteLength(entry.canonicalJson, "utf8"),
                    canonicalJson: entry.canonicalJson,
                    contentHash: entry.contentHash,
                    createdAtMs: entry.createdAt,
                    sequence: entry.shareSequence,
                    shareEventId: entry.shareEventId,
                    shareId: input.shareId,
                    subjectId: entry.subjectId,
                    subjectKind: entry.subjectKind,
                })
                .run();
        }
    });
}
