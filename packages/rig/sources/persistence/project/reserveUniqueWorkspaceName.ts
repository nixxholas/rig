import { inDatabase } from "../database/inDatabase.js";
import { and, eq, ne } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import { projectNameKey } from "../../project/projectIdentity.js";
import type { DatabaseScope } from "../Transaction.js";

/**
 * Finds a workspace name no other workspace in the project already answers to.
 *
 * Two workspaces in one project may not share a name, so a name already in use gains a numeric
 * suffix rather than failing the request that asked for it.
 */
export async function reserveUniqueWorkspaceName(
    tx: DatabaseScope,
    options: { excludeWorkspaceId?: string; name: string; projectId: string },
): Promise<string> {
    return await inDatabase(tx, async (tx) => {
        const taken = async (candidate: string): Promise<boolean> => {
            const scope =
                options.excludeWorkspaceId === undefined
                    ? eq(projectWorkspaces.projectId, options.projectId)
                    : and(
                          eq(projectWorkspaces.projectId, options.projectId),
                          ne(projectWorkspaces.id, options.excludeWorkspaceId),
                      );
            return (
                (await tx
                    .select({ id: projectWorkspaces.id })
                    .from(projectWorkspaces)
                    .where(and(scope, eq(projectWorkspaces.nameKey, projectNameKey(candidate))))
                    .get()) !== undefined
            );
        };
        if (!(await taken(options.name))) return options.name;
        for (let suffix = 2; ; suffix += 1) {
            const candidate = `${options.name} (${String(suffix)})`;
            if (!(await taken(candidate))) return candidate;
        }
    });
}
