import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * A workspace has one name again, and its branch follows that name.
 *
 * `title` held the name inherited from the first chat while `name` kept the placeholder the
 * workspace was created with, so the inherited name reached nobody. Inheritance now writes `name`
 * itself, `name_configured` records that the name was chosen on purpose and inheritance must leave
 * it alone, and `branch` makes the managed branch durable instead of deriving it from the immutable
 * folder key it no longer has to match.
 */
export async function workspaceBranchNaming(database: SessionDatabase): Promise<void> {
    await database.run(sql.raw("ALTER TABLE project_workspaces DROP COLUMN title"));
    await database.run(
        sql.raw(
            "ALTER TABLE project_workspaces ADD COLUMN name_configured INTEGER NOT NULL DEFAULT 0",
        ),
    );
    await database.run(
        sql.raw("ALTER TABLE project_workspaces ADD COLUMN branch TEXT NOT NULL DEFAULT ''"),
    );
    await database.run(
        sql.raw("UPDATE project_workspaces SET branch = 'worktree/' || storage_key"),
    );
}
