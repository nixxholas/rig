import { eq, lte, sql, type SQL } from "drizzle-orm";

import { projects, projectWorkspaces } from "../database/schema.js";

export type GitValues = {
    gitAhead: number;
    gitBehind: number;
    gitBranch: string | null;
    gitDetached: boolean;
    gitHead: string | null;
    gitUpstream: string | null;
};

export function projectNotUserMutatedSince(expectedVersion?: number): SQL {
    return expectedVersion === undefined
        ? sql`1`
        : lte(projects.userMutationVersion, expectedVersion);
}

export function workspaceVersion(expectedVersion?: number): SQL {
    return expectedVersion === undefined ? sql`1` : eq(projectWorkspaces.version, expectedVersion);
}

export function projectGitChanged(values: GitValues): SQL {
    return sql`(
        ${projects.gitBranch} IS NOT ${values.gitBranch}
        OR ${projects.gitHead} IS NOT ${values.gitHead}
        OR ${projects.gitUpstream} IS NOT ${values.gitUpstream}
        OR ${projects.gitAhead} IS NOT ${values.gitAhead}
        OR ${projects.gitBehind} IS NOT ${values.gitBehind}
        OR ${projects.gitDetached} IS NOT ${values.gitDetached ? 1 : 0}
    )`;
}

export function workspaceGitChanged(values: GitValues): SQL {
    return sql`(
        ${projectWorkspaces.gitBranch} IS NOT ${values.gitBranch}
        OR ${projectWorkspaces.gitHead} IS NOT ${values.gitHead}
        OR ${projectWorkspaces.gitUpstream} IS NOT ${values.gitUpstream}
        OR ${projectWorkspaces.gitAhead} IS NOT ${values.gitAhead}
        OR ${projectWorkspaces.gitBehind} IS NOT ${values.gitBehind}
        OR ${projectWorkspaces.gitDetached} IS NOT ${values.gitDetached ? 1 : 0}
    )`;
}
