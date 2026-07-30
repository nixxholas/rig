import { sql } from "drizzle-orm";

import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function queryProjectSecretIds(tx: TX, projectId: string): readonly string[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT secret_id FROM project_secret_attachments
            WHERE project_id = ${projectId}
            ORDER BY secret_id
        `)
        .map((row) => readString(row, "secret_id"));
}
