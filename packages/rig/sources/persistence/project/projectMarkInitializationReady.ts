import { and, eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectMarkInitializationReady(tx: TX, id: string, now: number): number {
    return Number(
        tx
            .update(projects)
            .set({
                initializationAttempt: sql`${projects.initializationAttempt} + 1`,
                initializationError: null,
                initializationStatus: "ready",
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, id), eq(projects.initializationStatus, "initializing")))
            .run().changes,
    );
}
