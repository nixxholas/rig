import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function remoteProjects(database: SessionDatabase): Promise<void> {
    const columns = new Set(
        (await database.all<{ name: string }>(sql.raw("PRAGMA table_info(projects)"))).map(
            (column) => column.name,
        ),
    );
    await addColumn(database, columns, "remote_source_json", "TEXT");
    await addColumn(database, columns, "required_secret_kind", "TEXT");
    await addColumn(database, columns, "creator_instance_id", "TEXT");
    await addColumn(database, columns, "creator_profile_id", "TEXT");
}

async function addColumn(
    database: SessionDatabase,
    columns: ReadonlySet<string>,
    name: string,
    type: "TEXT",
): Promise<void> {
    if (columns.has(name)) return;
    await database.run(sql.raw(`ALTER TABLE projects ADD COLUMN ${name} ${type}`));
}
