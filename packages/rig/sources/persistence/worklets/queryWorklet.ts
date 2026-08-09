import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { readWorkletRow, readWorkletVersionRow, type StoredWorklet } from "./queryWorklets.js";

export async function queryWorklet(
    tx: DatabaseScope,
    name: string,
): Promise<StoredWorklet | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.get<Record<string, unknown>>(
            sql`SELECT * FROM worklets WHERE name = ${name}`,
        );
        if (row === undefined) return undefined;
        const versions = (
            await tx.all<Record<string, unknown>>(
                sql`SELECT * FROM worklet_versions WHERE worklet_name = ${name} ORDER BY version ASC`,
            )
        ).map(readWorkletVersionRow);
        return readWorkletRow(row, versions);
    });
}
