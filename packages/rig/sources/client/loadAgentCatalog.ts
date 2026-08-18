import { resolve } from "node:path";

import type { Agent, HappyAgentClient, Project, Workspace } from "@slopus/happy-agent-client";

/** One top-level agent together with the file workspace that owns it. */
export interface AgentCatalogEntry {
    agent: Agent;
    cwd: string;
    projectId: string;
    workspaceId: string;
}

export interface AgentCatalog {
    entries: AgentCatalogEntry[];
    projects: Project[];
    workspaces: Workspace[];
}

/**
 * Reads the public project/workspace catalogs and flattens their ordered
 * top-level agent series for terminal pickers.
 *
 * There is deliberately no global agent-list call: root agents come from
 * projects and child-workspace agents come from workspaces.
 */
export async function loadAgentCatalog(client: HappyAgentClient): Promise<AgentCatalog> {
    const [projectResponse, workspaceResponse] = await Promise.all([
        client.listProjects(),
        client.listWorkspaces({ includeArchived: true }),
    ]);
    const projects = projectResponse.projects;
    const workspaces = workspaceResponse.workspaces;
    const entries: AgentCatalogEntry[] = [];
    for (const project of projects) {
        if (project.status === "archived") continue;
        const cwd = computePath(project);
        for (const agent of project.agents) {
            if (agent.archivedAt !== null) continue;
            entries.push({
                agent,
                cwd,
                projectId: project.id,
                workspaceId: project.id,
            });
        }
    }
    for (const workspace of workspaces) {
        if (workspace.id === workspace.projectId || workspace.archivedAt !== null) continue;
        const cwd = computePath(workspace);
        for (const agent of workspace.agents) {
            if (agent.archivedAt !== null) continue;
            entries.push({
                agent,
                cwd,
                projectId: workspace.projectId,
                workspaceId: workspace.id,
            });
        }
    }
    return { entries, projects, workspaces };
}

/** Finds the deepest registered file workspace whose host path is this cwd. */
export function workspaceForCwd(
    catalog: AgentCatalog,
    cwd: string,
): Workspace | Project | undefined {
    const target = resolve(cwd);
    const candidates: (Workspace | Project)[] = [
        ...catalog.projects,
        ...catalog.workspaces.filter((workspace) => workspace.id !== workspace.projectId),
    ];
    return candidates
        .filter(
            (workspace) =>
                workspace.compute.type === "host" && resolve(workspace.compute.path) === target,
        )
        .sort((left, right) => computePath(right).length - computePath(left).length)[0];
}

/** Registers the cwd as a project only when no public workspace already owns it. */
export async function ensureWorkspaceForCwd(
    client: HappyAgentClient,
    cwd: string,
): Promise<Workspace | Project> {
    const catalog = await loadAgentCatalog(client);
    const existing = workspaceForCwd(catalog, cwd);
    if (existing !== undefined) {
        const project = catalog.projects.find((candidate) => candidate.id === existing.id);
        if (project === undefined || project.status !== "archived") return existing;
        // Registering an archived project path is the documented revival
        // operation; do not try to create an agent inside an archived root.
        return (await client.registerProject({ path: resolve(cwd) })).project;
    }
    return (await client.registerProject({ path: resolve(cwd) })).project;
}

function computePath(resource: Workspace | Project): string {
    return resource.compute.type === "host" ? resource.compute.path : `[${resource.compute.type}]`;
}
