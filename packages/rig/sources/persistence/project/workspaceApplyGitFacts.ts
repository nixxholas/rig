import { inDatabase } from "../database/inDatabase.js";
import { and, sql } from "drizzle-orm";
import type { GitRepositoryFacts } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { type GitValues, workspaceGitChanged } from "./projectConditions.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceApplyGitFacts(
    tx: DatabaseScope,
    projectId: string,
    id: string,
    facts: GitRepositoryFacts,
    now: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        const values: GitValues = {
            gitAhead: facts.ahead,
            gitBehind: facts.behind,
            gitBranch: facts.branch ?? null,
            gitDetached: facts.detached,
            gitHead: facts.head ?? null,
            gitUpstream: facts.upstream ?? null,
        };
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        ...values,
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(and(workspaceScope(projectId, id), workspaceGitChanged(values)))
                    .run()
            ).rowsAffected,
        );
    });
}
