import { and, eq, type SQL } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import { workspaceVersion } from "./projectConditions.js";

export function workspaceScope(projectId: string, workspaceId: string, version?: number): SQL {
    return and(
        eq(projectWorkspaces.id, workspaceId),
        eq(projectWorkspaces.projectId, projectId),
        workspaceVersion(version),
    )!;
}
