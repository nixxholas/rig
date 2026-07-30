import { and, eq, isNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectVersion } from "./projectConditions.js";

export function projectArchive(tx: TX, id: string, now: number, version?: number): number {
    return Number(
        tx
            .update(projects)
            .set({
                archivedAtMs: now,
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, id), isNull(projects.archivedAtMs), projectVersion(version)))
            .run().changes,
    );
}
