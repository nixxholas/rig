import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";

/** Advances and returns the revision committed with one logical folder-tree mutation. */
export async function advanceFolderCatalogRevision(tx: DatabaseScope): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.get<{ revision: number }>(
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
    });
}
