import { eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectRefresh(tx: TX, id: string, now: number): number {
    return Number(
        tx
            .update(projects)
            .set({
                initializationAttempt: sql`${projects.initializationAttempt} + 1`,
                initializationError: null,
                initializationStatus: "initializing",
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(eq(projects.id, id))
            .run().changes,
    );
}
