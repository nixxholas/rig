import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function remoteWorkspaces(database: SessionDatabase): void {
    const columns = new Set(
        database
            .all<{ name: string }>(sql.raw("PRAGMA table_info(project_workspaces)"))
            .map((column) => column.name),
    );
    if (!columns.has("creator_instance_id")) {
        database.run(sql.raw("ALTER TABLE project_workspaces ADD COLUMN creator_instance_id TEXT"));
    }
    if (!columns.has("creator_profile_id")) {
        database.run(sql.raw("ALTER TABLE project_workspaces ADD COLUMN creator_profile_id TEXT"));
    }
}
