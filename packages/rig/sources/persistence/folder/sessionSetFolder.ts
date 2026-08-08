import { eq } from "drizzle-orm";

import { sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Files one chat into a folder, or takes it back out with `null`.
 *
 * Only the folder changes. Whether a chat is Unsorted is decided when it is created and never by
 * filing: a chat born in a project or a workspace is sorted by belonging there, so taking it out of
 * a folder leaves it exactly as sorted as it was. A chat born in the folder tree with no folder
 * keeps waiting to be sorted for as long as it has none, and filing it ends that wait by giving it
 * one rather than by forgetting where it came from.
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
            .set({ folderId, updatedAtMs: now })
            .where(eq(sessions.id, sessionId))
            .run().changes,
    );
}
