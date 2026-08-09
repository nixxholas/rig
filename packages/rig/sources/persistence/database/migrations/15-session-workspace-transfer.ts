import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function sessionWorkspaceTransfer(database: SessionDatabase): Promise<void> {
    const sessions = (
        await database.all<{ name: string }>(
            sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
        )
    )[0];
    if (sessions === undefined) return;
    await database.run(
        sql.raw(
            `ALTER TABLE sessions ADD COLUMN workspace_transfer_json TEXT NOT NULL DEFAULT '{"status":"idle"}'`,
        ),
    );
}
