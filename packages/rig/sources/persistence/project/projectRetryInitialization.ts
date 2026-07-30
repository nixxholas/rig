import { and, eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectRetryInitialization(tx: TX, id: string, now: number): number {
    return Number(
        tx
            .update(projects)
            .set({
                initializationError: null,
                initializationStatus: "initializing",
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, id), eq(projects.initializationStatus, "failed")))
            .run().changes,
    );
}
