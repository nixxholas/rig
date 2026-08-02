import { sql } from "drizzle-orm";

import type { Webapp } from "../../protocol/WebappProtocol.js";
import type { TX } from "../Transaction.js";
import { readWebappRow, readWebappVersionRow } from "./queryWebapps.js";

export function queryWebapp(tx: TX, name: string): Webapp | undefined {
    const row = tx.get<Record<string, unknown>>(sql`SELECT * FROM webapps WHERE name = ${name}`);
    if (row === undefined) return undefined;
    const versions = tx
        .all<Record<string, unknown>>(
            sql`SELECT * FROM webapp_versions WHERE webapp_name = ${name} ORDER BY version ASC`,
        )
        .map(readWebappVersionRow);
    return readWebappRow(row, versions);
}
