import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";

/** The durable revision represented by a folder catalog snapshot. */
export function queryFolderCatalogRevision(tx: TX): number {
    const row = tx.get<{ revision: number }>(
        sql.raw("SELECT revision FROM folder_catalog WHERE id = 1"),
    );
    if (row === undefined || !Number.isSafeInteger(row.revision) || row.revision < 0) {
        throw new Error("The folder catalog revision is unavailable.");
    }
    return row.revision;
}
