import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readWorkletRow, readWorkletVersionRow, type StoredWorklet } from "./queryWorklets.js";

export function queryWorklet(tx: TX, name: string): StoredWorklet | undefined {
    const row = tx.get<Record<string, unknown>>(sql`SELECT * FROM worklets WHERE name = ${name}`);
    if (row === undefined) return undefined;
    const versions = tx
        .all<Record<string, unknown>>(
            sql`SELECT * FROM worklet_versions WHERE worklet_name = ${name} ORDER BY version ASC`,
        )
        .map(readWorkletVersionRow);
    return readWorkletRow(row, versions);
}
