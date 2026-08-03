import { and, eq, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectNotUserMutatedSince } from "./projectConditions.js";

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
                userMutationVersion: sql`${projects.version} + 1`,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, id), projectNotUserMutatedSince(version)))
            .run().changes,
    );
}
