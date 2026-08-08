import { and, eq, sql } from "drizzle-orm";

import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function projectMarkCloneReady(tx: TX, id: string, now: number): number {
    return Number(
        tx
            .update(projects)
            .set({
                presence: "present",
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, id), eq(projects.initializationStatus, "initializing")))
            .run().changes,
    );
}
