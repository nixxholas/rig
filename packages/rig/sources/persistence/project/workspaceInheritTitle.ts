import { and, isNull, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceInheritTitle(
    tx: TX,
    projectId: string,
    id: string,
    title: string,
    now: number,
): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                title,
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(and(workspaceScope(projectId, id), isNull(projectWorkspaces.title)))
            .run().changes,
    );
}
