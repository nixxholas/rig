import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function sessionWorkspaceWaiting(database: SessionDatabase): Promise<void> {
    const sessions = (
        await database.all<{ name: string }>(
            sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
        )
    )[0];
    if (sessions === undefined) return;
    const alreadyPresent = (
        await database.all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
    ).some((column) => column.name === "workspace_queue_waiting");
    if (alreadyPresent) return;
    await database.run(
        sql.raw(
            "ALTER TABLE sessions ADD COLUMN workspace_queue_waiting INTEGER NOT NULL DEFAULT 0",
        ),
    );
}
