import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectMarkInitializationReady(
    tx: DatabaseScope,
    id: string,
    now: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        initializationAttempt: sql`${projects.initializationAttempt} + 1`,
                        initializationError: null,
                        initializationStatus: "ready",
                        updatedAtMs: now,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(
                        and(eq(projects.id, id), eq(projects.initializationStatus, "initializing")),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
