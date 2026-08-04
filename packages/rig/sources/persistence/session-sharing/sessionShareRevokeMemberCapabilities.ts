import { and, eq, sql } from "drizzle-orm";

import { sessionShareCapabilities } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Mark every active capability revoked for one member, or for every member of a
 * share when `shareMemberId` is omitted. Returns how many rows changed. This is
 * a single-statement operation, so it composes inside whatever transaction the
 * caller already holds without opening its own.
 */
export function sessionShareRevokeMemberCapabilities(
    tx: TX,
    input: { now: number; shareMemberId?: string; shareId: string },
): number {
    const memberFilter =
        input.shareMemberId === undefined
            ? // Whole-share revoke: match every member of the share through a
              // subquery, mirroring how `sessionShareStop` scopes its grant revoke.
              sql`${sessionShareCapabilities.shareMemberId} IN (
                  SELECT share_member_id FROM session_share_members WHERE share_id = ${input.shareId}
              )`
            : eq(sessionShareCapabilities.shareMemberId, input.shareMemberId);
    return tx
        .update(sessionShareCapabilities)
        .set({ revokedAtMs: input.now, state: "revoked" })
        .where(and(memberFilter, eq(sessionShareCapabilities.state, "active")))
        .run().changes;
}
