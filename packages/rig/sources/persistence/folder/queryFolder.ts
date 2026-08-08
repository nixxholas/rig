import { eq } from "drizzle-orm";

import type { Folder } from "../../protocol/index.js";
import { folders } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { folderReadRow } from "./impl/folderReadRow.js";

export function queryFolder(tx: TX, folderId: string): Folder | undefined {
    const row = tx.select().from(folders).where(eq(folders.id, folderId)).get();
    return row === undefined ? undefined : folderReadRow(row);
}
