import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/** Keeps bounded folder-item mutation receipt pruning local to one durable item. */
export function folderItemMutationRetention(database: SessionDatabase): void {
    database.run(
        sql.raw(
            "CREATE INDEX folder_item_mutations_item_created ON folder_item_mutations(item_id, created_at_ms, mutation_id)",
        ),
    );
}
