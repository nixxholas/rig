import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectRestore(tx: DatabaseScope, id: string, now: number): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        archivedAtMs: null,
                        updatedAtMs: now,
                        userMutationVersion: sql`${projects.version} + 1`,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(and(eq(projects.id, id), isNotNull(projects.archivedAtMs)))
                    .run()
            ).rowsAffected,
        );
    });
}
