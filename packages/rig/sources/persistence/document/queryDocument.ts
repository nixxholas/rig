import { eq } from "drizzle-orm";

import type { Document } from "../../protocol/index.js";
import { documents } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryDocument(tx: TX, id: string): Document | undefined {
    const row = tx.select().from(documents).where(eq(documents.id, id)).get();
    if (row === undefined) return undefined;
    return {
        createdAt: row.createdAtMs,
        createdBy: {
            instanceId: row.createdByInstanceId,
            ...(row.createdByProfileId === null ? {} : { profileId: row.createdByProfileId }),
        },
        firstRetainedVersion: row.firstRetainedVersion,
        id: row.id,
        mimeType: row.mimeType,
        state: JSON.parse(row.stateJson) as unknown,
        ...(row.unreadCursor === null ? {} : { unreadCursor: row.unreadCursor }),
        updatedAt: row.updatedAtMs,
        version: row.version,
    };
}
