import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function sessionWorkspaceTransfer(database: SessionDatabase): void {
    const sessions = database.get<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (sessions === undefined) return;
    database.run(
        sql.raw(
            `ALTER TABLE sessions ADD COLUMN workspace_transfer_json TEXT NOT NULL DEFAULT '{"status":"idle"}'`,
        ),
    );
}
