import { and, ne, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceBeginArchive(
    tx: TX,
    projectId: string,
    id: string,
    now: number,
    version?: number,
): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                error: null,
                status: "archiving",
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(
                and(
                    workspaceScope(projectId, id, version),
                    ne(projectWorkspaces.status, "archived"),
                ),
            )
            .run().changes,
    );
}
