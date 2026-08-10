import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { Folder } from "../../protocol/index.js";
import { folders } from "../database/schema.js";
import { folderReadRow } from "./impl/folderReadRow.js";

export async function queryFolder(ctx: Context, folderId: string): Promise<Folder | undefined> {
    return await inDatabase(ctx, "rig.sql.folder.queryFolder", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.select().from(folders).where(eq(folders.id, folderId)).get();
        return row === undefined ? undefined : folderReadRow(row);
    });
}
