import { join } from "node:path";
import { stat } from "node:fs/promises";

import { Type } from "@sinclair/typebox";

import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import {
    createLocalProjectWorkspaceHost,
    type ProjectWorkspaceHost,
} from "../projects/ProjectHost.js";
import type { GitModule } from "../git/GitModule.js";

const createWorkspaceSchema = Type.Object(
    {
        baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        id: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
        identity: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        name: Type.String({ minLength: 1, maxLength: 500 }),
        nameConfigured: Type.Optional(Type.Boolean()),
        secret: Type.Optional(
            Type.Object({ kind: Type.Literal("github") }, { additionalProperties: false }),
        ),
    },
    { additionalProperties: false },
);
const renameWorkspaceSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        name: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
);
const reorderSchema = Type.Object(
    { afterId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 128 })]) },
    { additionalProperties: false },
);
const emptySchema = Type.Object({}, { additionalProperties: false });

export interface WorkspaceRouteOptions {
    readonly agent: LoadedHappyAgent;
    readonly git?: GitModule;
    readonly host?: ProjectWorkspaceHost;
}

export function createWorkspaceRoutes(options: WorkspaceRouteOptions): AgentHttpRouteGroup {
    const host = options.host ?? createLocalProjectWorkspaceHost();
    const agentId = options.agent.agent.id;
    const projects = options.agent.modules.projects;
    const workspaces = options.agent.modules.workspaces;
    const assertEnabled = (): void => {
        if (!options.agent.configuration.values.features.workspaces) {
            throw new AgentHttpError(503, "Workspaces are disabled by configuration.");
        }
    };
    return createRouteGroup("workspaces", [
        {
            method: "GET",
            path: "/v0/projects/:projectId/workspaces",
            handle: async ({ ctx, response, url }) => {
                assertEnabled();
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId/workspaces"),
                    "projectId",
                );
                await requireProject(ctx, projectId);
                const rows = await workspaces.list(ctx, agentId, {
                    includeArchived: true,
                    projectRef: projectId,
                });
                sendJson(response, 200, {
                    workspaces: await Promise.all(
                        rows.map((row) => toWorkspace(ctx, projectId, row)),
                    ),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/workspaces",
            handle: async ({ ctx, request, response, url }) => {
                assertEnabled();
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId/workspaces"),
                    "projectId",
                );
                const project = await requireProject(ctx, projectId);
                const body = await readValidatedBody(request, createWorkspaceSchema);
                if (body.identity !== undefined && body.identity !== agentId) {
                    throw new AgentHttpError(
                        403,
                        "The workspace identity does not match this agent.",
                    );
                }
                const workspace = await workspaces.create(ctx, agentId, {
                    ...(body.id === undefined ? {} : { id: body.id }),
                    ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                    name: body.name,
                    ...(body.id === undefined ? {} : { operationId: body.id }),
                    projectRef: projectId,
                });
                const workspacePath = join(
                    project.repositoryRef,
                    ".happy-workspaces",
                    workspace.id,
                );
                if (host.createWorkspace !== undefined) {
                    await host.createWorkspace(ctx, {
                        branch: body.name,
                        path: workspacePath,
                        projectPath: project.repositoryRef,
                        ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                    });
                }
                sendJson(response, 202, {
                    workspace: await toWorkspace(ctx, projectId, workspace, workspacePath),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/projects/:projectId/workspaces/:workspaceId",
            handle: async ({ ctx, response, url }) => {
                assertEnabled();
                const params = requireParams(
                    url.pathname,
                    "/v0/projects/:projectId/workspaces/:workspaceId",
                );
                const projectId = requireParam(params, "projectId");
                const workspaceId = requireParam(params, "workspaceId");
                await requireProject(ctx, projectId);
                const workspace = await workspaces.get(ctx, agentId, workspaceId);
                if (workspace === undefined || workspace.projectRef !== projectId) {
                    throw new AgentHttpError(404, "The workspace was not found.");
                }
                sendJson(response, 200, {
                    workspace: await toWorkspace(ctx, projectId, workspace),
                });
            },
        },
        {
            method: "PATCH",
            path: "/v0/projects/:projectId/workspaces/:workspaceId",
            handle: async ({ request, url }) => {
                assertEnabled();
                requireParams(url.pathname, "/v0/projects/:projectId/workspaces/:workspaceId");
                await readValidatedBody(request, renameWorkspaceSchema);
                throw new AgentHttpError(
                    503,
                    "Workspace rename is not available in the Happy Agent host.",
                );
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/workspaces/:workspaceId/archive",
            handle: async ({ ctx, request, response, url }) => {
                assertEnabled();
                const params = requireParams(
                    url.pathname,
                    "/v0/projects/:projectId/workspaces/:workspaceId/archive",
                );
                const projectId = requireParam(params, "projectId");
                const workspaceId = requireParam(params, "workspaceId");
                await requireProject(ctx, projectId);
                const current = await workspaces.get(ctx, agentId, workspaceId);
                if (current === undefined || current.projectRef !== projectId) {
                    throw new AgentHttpError(404, "The workspace was not found.");
                }
                assertVersion(request.headers["if-match"], current.updatedAt, "workspace");
                await readValidatedBody(request, emptySchema);
                const workspace = await workspaces.archive(ctx, agentId, workspaceId);
                const workspacePath = join(
                    (await requireProject(ctx, projectId)).repositoryRef,
                    ".happy-workspaces",
                    workspace.id,
                );
                if (host.removeWorkspace !== undefined) {
                    await host.removeWorkspace(ctx, workspacePath);
                }
                sendJson(response, 202, {
                    workspace: await toWorkspace(ctx, projectId, workspace, workspacePath),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/workspaces/:workspaceId/reorder",
            handle: async ({ request, url }) => {
                assertEnabled();
                requireParams(
                    url.pathname,
                    "/v0/projects/:projectId/workspaces/:workspaceId/reorder",
                );
                await readValidatedBody(request, reorderSchema);
                throw new AgentHttpError(
                    503,
                    "Workspace ordering is not available in the Happy Agent host.",
                );
            },
        },
    ]);

    async function requireProject(ctx: import("@steve.kite/stdlib").Context, projectId: string) {
        const project = await projects.get(ctx, agentId, projectId);
        if (project === undefined) throw new AgentHttpError(404, "The project was not found.");
        return project;
    }

    async function toWorkspace(
        ctx: import("@steve.kite/stdlib").Context,
        projectId: string,
        workspace: Awaited<ReturnType<typeof workspaces.get>> extends infer T
            ? Exclude<T, undefined>
            : never,
        explicitPath?: string,
    ) {
        const project = await requireProject(ctx, projectId);
        const path = explicitPath ?? join(project.repositoryRef, ".happy-workspaces", workspace.id);
        let present = false;
        try {
            present = (await stat(path)).isDirectory();
        } catch {
            present = false;
        }
        const git =
            options.git === undefined
                ? undefined
                : await options.git.facts(present ? path : project.repositoryRef);
        return {
            archivedAt: workspace.archivedAt,
            baseCommit: undefined,
            baseRef: workspace.baseRef,
            branch: workspace.name,
            createdAt: workspace.createdAt,
            ...(git === undefined ? {} : { git }),
            gitCommonDir: join(project.repositoryRef, ".git"),
            id: workspace.id,
            kind: "git_worktree" as const,
            name: workspace.name,
            path,
            presence: present ? ("present" as const) : ("missing" as const),
            projectId,
            status: mapStatus(workspace.status),
            storageKey: workspace.id,
            updatedAt: workspace.updatedAt,
            version: workspace.updatedAt,
        };
    }
}

function requireParams(pathname: string, template: string): Record<string, string> {
    const actual = pathname.split("/").filter(Boolean);
    const expected = template.split("/").filter(Boolean);
    if (actual.length !== expected.length) throw new AgentHttpError(404, "Route not found.");
    const params: Record<string, string> = {};
    expected.forEach((value, index) => {
        if (value.startsWith(":")) params[value.slice(1)] = decodeURIComponent(actual[index] ?? "");
        else if (value !== actual[index]) throw new AgentHttpError(404, "Route not found.");
    });
    return params;
}

function requireParam(params: Record<string, string>, name: string): string {
    const value = params[name];
    if (value === undefined || value.length === 0)
        throw new AgentHttpError(404, "Route not found.");
    return value;
}

function assertVersion(
    value: string | string[] | undefined,
    current: number,
    entity: string,
): void {
    if (typeof value !== "string")
        throw new AgentHttpError(400, `The ${entity} version is invalid.`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new AgentHttpError(400, `The ${entity} version is invalid.`);
    }
    if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
        throw new AgentHttpError(400, `The ${entity} version is invalid.`);
    }
    if (parsed !== current) {
        throw new AgentHttpError(409, `The ${entity} has changed.`, { currentVersion: current });
    }
}

function mapStatus(
    status: "active" | "archived" | "archiving" | "failed" | "initializing" | "ready",
): "archived" | "archiving" | "failed" | "initializing" | "ready" {
    if (status === "active") return "ready";
    return status;
}
