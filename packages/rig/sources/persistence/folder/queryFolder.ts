import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { Folder } from "../../protocol/index.js";
import { folders } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { folderReadRow } from "./impl/folderReadRow.js";

export async function queryFolder(
    tx: DatabaseScope,
    folderId: string,
): Promise<Folder | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.select().from(folders).where(eq(folders.id, folderId)).get();
        return row === undefined ? undefined : folderReadRow(row);
    });
}
