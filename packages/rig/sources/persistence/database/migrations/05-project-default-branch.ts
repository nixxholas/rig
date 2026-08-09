import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function projectDefaultBranch(database: SessionDatabase): Promise<void> {
    await database.run(sql.raw("ALTER TABLE projects ADD COLUMN default_branch TEXT"));
}
