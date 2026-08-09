import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";

import type { FolderItem, FolderItemTarget } from "../../protocol/index.js";
import { documents, projects, projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function queryFolderItemTargetExists(tx: TX, target: FolderItemTarget): boolean {
    switch (target.kind) {
        case "project":
            return projectIsActive(tx, target.projectId);
        case "workspace": {
            const workspace = tx
                .select({
                    archivedAtMs: projectWorkspaces.archivedAtMs,
                    projectId: projectWorkspaces.projectId,
                    status: projectWorkspaces.status,
                })
                .from(projectWorkspaces)
                .where(eq(projectWorkspaces.id, target.workspaceId))
                .get();
            return (
                workspace !== undefined &&
                workspace.archivedAtMs === null &&
                workspace.status !== "archiving" &&
                workspace.status !== "archived" &&
                projectIsActive(tx, workspace.projectId)
            );
        }
        case "document":
            return (
                tx
                    .select({ id: documents.id })
                    .from(documents)
                    .where(eq(documents.id, target.documentId))
                    .get() !== undefined
            );
    }
}

/** Hides live links whose project or workspace target is no longer active. */
export function folderItemsWithActiveTargets(
    tx: TX,
    items: readonly FolderItem[],
): readonly FolderItem[] {
    const projectIds = [
        ...new Set(
            items.flatMap((item) =>
                item.target.kind === "project" ? [item.target.projectId] : [],
            ),
        ),
    ];
    const workspaceIds = [
        ...new Set(
            items.flatMap((item) =>
                item.target.kind === "workspace" ? [item.target.workspaceId] : [],
            ),
        ),
    ];
    const activeProjects = new Set(
        (projectIds.length === 0
            ? []
            : tx
                  .select({ id: projects.id })
                  .from(projects)
                  .where(and(inArray(projects.id, projectIds), isNull(projects.archivedAtMs)))
                  .all()
        ).map((row) => row.id),
    );
    const workspaces =
        workspaceIds.length === 0
            ? []
            : tx
                  .select({
                      id: projectWorkspaces.id,
                      projectId: projectWorkspaces.projectId,
                  })
                  .from(projectWorkspaces)
                  .where(
                      and(
                          inArray(projectWorkspaces.id, workspaceIds),
                          isNull(projectWorkspaces.archivedAtMs),
                          notInArray(projectWorkspaces.status, ["archiving", "archived"]),
                      ),
                  )
                  .all();
    const workspaceProjectIds = [...new Set(workspaces.map((row) => row.projectId))];
    const activeWorkspaceProjects = new Set(
        (workspaceProjectIds.length === 0
            ? []
            : tx
                  .select({ id: projects.id })
                  .from(projects)
                  .where(
                      and(inArray(projects.id, workspaceProjectIds), isNull(projects.archivedAtMs)),
                  )
                  .all()
        ).map((row) => row.id),
    );
    const activeWorkspaces = new Set(
        workspaces
            .filter((workspace) => activeWorkspaceProjects.has(workspace.projectId))
            .map((workspace) => workspace.id),
    );
    return items.filter(
        (item) =>
            item.archivedAt !== undefined ||
            item.target.kind === "document" ||
            (item.target.kind === "project" && activeProjects.has(item.target.projectId)) ||
            (item.target.kind === "workspace" && activeWorkspaces.has(item.target.workspaceId)),
    );
}

function projectIsActive(tx: TX, projectId: string): boolean {
    return (
        tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.id, projectId), isNull(projects.archivedAtMs)))
            .get() !== undefined
    );
}
