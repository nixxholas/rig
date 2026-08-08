import { and, eq, ne } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";

/**
 * Finds a branch name no other workspace in the project has taken.
 *
 * Two workspaces cannot share a branch, and Git will not create one twice, so a name already in
 * use gains a numeric suffix in the same shape workspace names and storage keys use. The caller
 * supplies `isBranchUnavailable` to include refs Git already holds, which is what keeps a
 * reservation honest about branches Rig did not create.
 *
 * A workspace never collides with itself. Git holds the branch it is already on, so a rename that
 * slugs to that same branch would otherwise be pushed onto a suffix and move the branch for
 * nothing.
 */
export function reserveUniqueBranch(
    tx: TX,
    options: {
        branch: string;
        excludeWorkspaceId?: string;
        isBranchUnavailable?: (branch: string) => boolean;
        projectId: string;
    },
): string {
    const own =
        options.excludeWorkspaceId === undefined
            ? undefined
            : tx
                  .select({ branch: projectWorkspaces.branch })
                  .from(projectWorkspaces)
                  .where(
                      and(
                          eq(projectWorkspaces.projectId, options.projectId),
                          eq(projectWorkspaces.id, options.excludeWorkspaceId),
                      ),
                  )
                  .get()?.branch;
    const taken = (candidate: string): boolean => {
        if (candidate === own) return false;
        if (options.isBranchUnavailable?.(candidate) === true) return true;
        const scope =
            options.excludeWorkspaceId === undefined
                ? eq(projectWorkspaces.projectId, options.projectId)
                : and(
                      eq(projectWorkspaces.projectId, options.projectId),
                      ne(projectWorkspaces.id, options.excludeWorkspaceId),
                  );
        return (
            tx
                .select({ id: projectWorkspaces.id })
                .from(projectWorkspaces)
                .where(and(scope, eq(projectWorkspaces.branch, candidate)))
                .get() !== undefined
        );
    };
    if (!taken(options.branch)) return options.branch;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${options.branch}-${String(suffix)}`;
        if (!taken(candidate)) return candidate;
    }
}
