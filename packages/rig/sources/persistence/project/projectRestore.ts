import { and, eq, isNotNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectRestore(tx: TX, id: string, now: number): number {
    return Number(
        tx
            .update(projects)
            .set({
                archivedAtMs: null,
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, id), isNotNull(projects.archivedAtMs)))
            .run().changes,
    );
}
