import { inDatabase } from "../database/inDatabase.js";
import { and, ne, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceBeginArchive(
    tx: DatabaseScope,
    projectId: string,
    id: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
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
                    .run()
            ).rowsAffected,
        );
    });
}
