import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";

/** Advances and returns the revision committed with one logical folder-tree mutation. */
export function advanceFolderCatalogRevision(tx: TX): number {
    const row = tx.get<{ revision: number }>(
        sql.raw(`
        UPDATE folder_catalog
        SET revision = revision + 1
        WHERE id = 1
        RETURNING revision
    `),
    );
    if (row === undefined || !Number.isSafeInteger(row.revision) || row.revision < 1) {
        throw new Error("The folder catalog revision could not be advanced.");
    }
    return row.revision;
}
