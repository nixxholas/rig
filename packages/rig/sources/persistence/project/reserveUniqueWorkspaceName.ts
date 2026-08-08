import { and, eq, ne } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import { projectNameKey } from "../../project/projectIdentity.js";
import type { TX } from "../Transaction.js";

/**
 * Finds a workspace name no other workspace in the project already answers to.
 *
 * Two workspaces in one project may not share a name, so a name already in use gains a numeric
 * suffix rather than failing the request that asked for it.
 */
export function reserveUniqueWorkspaceName(
    tx: TX,
    options: { excludeWorkspaceId?: string; name: string; projectId: string },
): string {
    const taken = (candidate: string): boolean => {
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
                .where(and(scope, eq(projectWorkspaces.nameKey, projectNameKey(candidate))))
                .get() !== undefined
        );
    };
    if (!taken(options.name)) return options.name;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${options.name} (${String(suffix)})`;
        if (!taken(candidate)) return candidate;
    }
}
