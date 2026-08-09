import { inDatabase } from "../database/inDatabase.js";
import { eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectRefresh(tx: DatabaseScope, id: string, now: number): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        initializationAttempt: sql`${projects.initializationAttempt} + 1`,
                        initializationError: null,
                        initializationStatus: "initializing",
                        updatedAtMs: now,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(eq(projects.id, id))
                    .run()
            ).rowsAffected,
        );
    });
}
