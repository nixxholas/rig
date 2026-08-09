import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Keeps bounded folder-item mutation receipt pruning local to one durable item. */
export async function folderItemMutationRetention(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(
            "CREATE INDEX folder_item_mutations_item_created ON folder_item_mutations(item_id, created_at_ms, mutation_id)",
        ),
    );
}
