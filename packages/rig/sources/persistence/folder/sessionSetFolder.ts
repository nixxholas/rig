import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Files one chat into a folder. `null` takes it back out into Unsorted.
 *
 * Filing ends the wait: a chat that started out belonging nowhere stops being a candidate for the
 * Unsorted sweep the moment it lands somewhere, and starts waiting again if it is taken back out.
 */
export function sessionSetFolder(
    tx: TX,
    sessionId: string,
    folderId: string | null,
    now: number,
): number {
    return Number(
        tx
            .update(sessions)
            .set({
                folderId,
                updatedAtMs: now,
                unsortedSinceMs: folderId === null ? now : null,
            })
            .where(eq(sessions.id, sessionId))
            .run().changes,
    );
}
