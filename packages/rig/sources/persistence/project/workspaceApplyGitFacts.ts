import { and, sql } from "drizzle-orm";
import type { GitRepositoryFacts } from "../../protocol/index.js";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { type GitValues, workspaceGitChanged } from "./projectConditions.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceApplyGitFacts(
    tx: TX,
    projectId: string,
    id: string,
    facts: GitRepositoryFacts,
    now: number,
): number {
    const values: GitValues = {
        gitAhead: facts.ahead,
        gitBehind: facts.behind,
        gitBranch: facts.branch ?? null,
        gitDetached: facts.detached,
        gitHead: facts.head ?? null,
        gitUpstream: facts.upstream ?? null,
    };
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                ...values,
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(and(workspaceScope(projectId, id), workspaceGitChanged(values)))
            .run().changes,
    );
}
