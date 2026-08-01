import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function projectDefaultBranch(database: SessionDatabase): void {
    database.run(sql.raw("ALTER TABLE projects ADD COLUMN default_branch TEXT"));
}
