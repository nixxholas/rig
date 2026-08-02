import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function projectSettings(database: SessionDatabase): void {
    database.run(sql.raw("ALTER TABLE projects ADD COLUMN default_compute TEXT"));
    database.run(sql.raw("ALTER TABLE projects ADD COLUMN default_docker_image TEXT"));
}
