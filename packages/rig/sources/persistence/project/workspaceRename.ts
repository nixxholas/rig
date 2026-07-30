import { and, eq, ne, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import { projectNameKey } from "../../project/projectIdentity.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceRename(
    tx: TX,
    projectId: string,
    id: string,
    name: string,
    now: number,
    version?: number,
): number {
    return inTx(tx, (tx) => {
        const reservedName = reserveUnique(
            name,
            (candidate) =>
                tx
                    .select({ id: projectWorkspaces.id })
                    .from(projectWorkspaces)
                    .where(
                        and(
                            eq(projectWorkspaces.projectId, projectId),
                            eq(projectWorkspaces.nameKey, projectNameKey(candidate)),
                            ne(projectWorkspaces.id, id),
                        ),
                    )
                    .get() !== undefined,
        );
        return Number(
            tx
                .update(projectWorkspaces)
                .set({
                    name: reservedName,
                    nameKey: projectNameKey(reservedName),
                    updatedAtMs: now,
                    version: sql`${projectWorkspaces.version} + 1`,
                })
                .where(workspaceScope(projectId, id, version))
                .run().changes,
        );
    });
}

function reserveUnique(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} (${String(suffix)})`;
        if (!taken(candidate)) return candidate;
    }
}
