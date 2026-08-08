import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function remoteProjects(database: SessionDatabase): void {
    const columns = new Set(
        database
            .all<{ name: string }>(sql.raw("PRAGMA table_info(projects)"))
            .map((column) => column.name),
    );
    addColumn(database, columns, "remote_source_json", "TEXT");
    addColumn(database, columns, "required_secret_kind", "TEXT");
    addColumn(database, columns, "creator_instance_id", "TEXT");
    addColumn(database, columns, "creator_profile_id", "TEXT");
}

function addColumn(
    database: SessionDatabase,
    columns: ReadonlySet<string>,
    name: string,
    type: "TEXT",
): void {
    if (columns.has(name)) return;
    database.run(sql.raw(`ALTER TABLE projects ADD COLUMN ${name} ${type}`));
}
