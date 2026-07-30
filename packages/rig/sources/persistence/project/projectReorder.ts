import { and, eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectVersion } from "./projectConditions.js";

export function projectReorder(
    tx: TX,
    id: string,
    orderKey: string,
    now: number,
    version?: number,
): number {
    return Number(
        tx
            .update(projects)
            .set({
                orderKey,
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, id), projectVersion(version)))
            .run().changes,
    );
}
