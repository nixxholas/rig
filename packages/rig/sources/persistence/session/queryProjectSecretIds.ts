import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { DatabaseScope } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export async function queryProjectSecretIds(
    tx: DatabaseScope,
    projectId: string,
): Promise<readonly string[]> {
    return await inDatabase(tx, async (tx) => {
        return (
            await tx.all<Record<string, unknown>>(sql`
            SELECT secret_id FROM project_secret_attachments
            WHERE project_id = ${projectId}
            ORDER BY secret_id
        `)
        ).map((row) => readString(row, "secret_id"));
    });
}
