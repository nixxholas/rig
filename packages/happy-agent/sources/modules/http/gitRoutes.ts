import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { ProjectFileError, type ProjectFilesModule } from "../files/ProjectFilesModule.js";
import { GitModule, gitWatchSchema, type GitEntity } from "../git/GitModule.js";

export interface GitRouteOptions {
    readonly agent: LoadedHappyAgent;
    readonly files: ProjectFilesModule;
    readonly git: GitModule;
}

export function createGitRoutes(options: GitRouteOptions): AgentHttpRouteGroup {
    const agentId = options.agent.agent.id;
    return createRouteGroup("git", [
        {
            method: "POST",
            path: "/v0/git/watch",
            handle: async ({ ctx, request, response }) => {
                const body = await readValidatedBody(request, gitWatchSchema);
                const entities: (GitEntity & { readonly root: string })[] = [];
                for (const entity of body.entities) {
                    try {
                        const root = await options.files.resolveRoot(
                            ctx,
                            agentId,
                            entity.projectId,
                            entity.workspaceId,
                        );
                        entities.push({ ...entity, root: root.root });
                    } catch (error) {
                        if (error instanceof ProjectFileError && error.status === 404) continue;
                        throw error;
                    }
                }
                const snapshots = await options.git.watch(entities);
                sendJson(response, 200, { snapshots });
            },
        },
        {
            method: "GET",
            path: "/v0/projects/:projectId/git",
            handle: async ({ ctx, response, url }) => {
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId/git"),
                    "projectId",
                );
                const root = await resolveRoot(ctx, projectId);
                sendJson(response, 200, {
                    git: await options.git.snapshot(root.root, `project:${projectId}`),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/projects/:projectId/workspaces/:workspaceId/git",
            handle: async ({ ctx, response, url }) => {
                const params = requireParams(
                    url.pathname,
                    "/v0/projects/:projectId/workspaces/:workspaceId/git",
                );
                const projectId = requireParam(params, "projectId");
                const workspaceId = requireParam(params, "workspaceId");
                const root = await resolveRoot(ctx, projectId, workspaceId);
                sendJson(response, 200, {
                    git: await options.git.snapshot(
                        root.root,
                        `workspace:${projectId}:${workspaceId}`,
                    ),
                });
            },
        },
    ]);

    async function resolveRoot(
        ctx: import("@steve.kite/stdlib").Context,
        projectId: string,
        workspaceId?: string,
    ) {
        try {
            return await options.files.resolveRoot(ctx, agentId, projectId, workspaceId);
        } catch (error) {
            if (error instanceof ProjectFileError) {
                throw new AgentHttpError(error.status, error.message, { code: error.code });
            }
            throw error;
        }
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
