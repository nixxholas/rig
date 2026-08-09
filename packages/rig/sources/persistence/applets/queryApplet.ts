import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { Applet } from "../../protocol/AppletProtocol.js";
import type { DatabaseScope } from "../Transaction.js";
import { readAppletRow, readAppletVersionRow } from "./queryApplets.js";

export async function queryApplet(tx: DatabaseScope, name: string): Promise<Applet | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.get<Record<string, unknown>>(
            sql`SELECT * FROM applets WHERE name = ${name}`,
        );
        if (row === undefined) return undefined;
        const versions = (
            await tx.all<Record<string, unknown>>(
                sql`SELECT * FROM applet_versions WHERE applet_name = ${name} ORDER BY version ASC`,
            )
        ).map(readAppletVersionRow);
        return readAppletRow(row, versions);
    });
}
