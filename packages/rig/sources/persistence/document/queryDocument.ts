import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { Document } from "../../protocol/index.js";
import { documents } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function queryDocument(tx: DatabaseScope, id: string): Promise<Document | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.select().from(documents).where(eq(documents.id, id)).get();
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
    });
}
