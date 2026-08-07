import { sql } from "drizzle-orm";

import type { Applet } from "../../protocol/AppletProtocol.js";
import type { TX } from "../Transaction.js";
import { readAppletRow, readAppletVersionRow } from "./queryApplets.js";

export function queryApplet(tx: TX, name: string): Applet | undefined {
    const row = tx.get<Record<string, unknown>>(sql`SELECT * FROM applets WHERE name = ${name}`);
    if (row === undefined) return undefined;
    const versions = tx
        .all<Record<string, unknown>>(
            sql`SELECT * FROM applet_versions WHERE applet_name = ${name} ORDER BY version ASC`,
        )
        .map(readAppletVersionRow);
    return readAppletRow(row, versions);
}
