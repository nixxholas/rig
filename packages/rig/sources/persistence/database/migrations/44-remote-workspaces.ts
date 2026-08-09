import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function remoteWorkspaces(database: SessionDatabase): Promise<void> {
    const columns = new Set(
        (
            await database.all<{ name: string }>(sql.raw("PRAGMA table_info(project_workspaces)"))
        ).map((column) => column.name),
    );
    if (!columns.has("creator_instance_id")) {
        await database.run(
            sql.raw("ALTER TABLE project_workspaces ADD COLUMN creator_instance_id TEXT"),
        );
    }
    if (!columns.has("creator_profile_id")) {
        await database.run(
            sql.raw("ALTER TABLE project_workspaces ADD COLUMN creator_profile_id TEXT"),
        );
    }
}
