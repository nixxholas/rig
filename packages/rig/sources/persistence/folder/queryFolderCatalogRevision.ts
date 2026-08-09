import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";

/** The durable revision represented by a folder catalog snapshot. */
export async function queryFolderCatalogRevision(tx: DatabaseScope): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.get<{ revision: number }>(
            sql.raw("SELECT revision FROM folder_catalog WHERE id = 1"),
        );
        if (row === undefined || !Number.isSafeInteger(row.revision) || row.revision < 0) {
            throw new Error("The folder catalog revision is unavailable.");
        }
        return row.revision;
    });
}
