import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function projectSettings(database: SessionDatabase): Promise<void> {
    await database.run(sql.raw("ALTER TABLE projects ADD COLUMN default_compute TEXT"));
    await database.run(sql.raw("ALTER TABLE projects ADD COLUMN default_docker_image TEXT"));
}
