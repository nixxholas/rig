import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { ProjectFileError, type ProjectFilesModule } from "../files/ProjectFilesModule.js";
import { GitModule, gitWatchSchema } from "@slopus/happy-agent-modules";
import type { GitTrackedEntity } from "@slopus/happy-agent-modules";

export interface GitRouteOptions {
    readonly agent: StartedHappyAgent;
    readonly files: ProjectFilesModule;
    /** Git itself, holding the daemon's one live watcher. Watching registers with it. */
    readonly git: GitModule;
}

export function createGitRoutes(options: GitRouteOptions): AgentHttpRouteGroup {
    return createRouteGroup("git", [
        {
            method: "POST",
            path: "/v0/git/watch",
            handle: async ({ ctx, request, response }) => {
                const body = await readValidatedBody(request, gitWatchSchema);
                const tracked: { readonly path: string; readonly entity: GitTrackedEntity }[] = [];
                for (const entity of body.entities) {
                    try {
                        const root = await options.files.resolveRoot(
                            ctx,
                            entity.projectId,
                            entity.workspaceId,
                        );
                        tracked.push({
                            path: root.root,
                            entity: {
                                path: root.root,
                                projectId: entity.projectId,
                                ...(entity.workspaceId === undefined
                                    ? {}
                                    : { workspaceId: entity.workspaceId }),
                            },
                        });
                    } catch (error) {
                        if (error instanceof ProjectFileError && error.status === 404) continue;
                        throw error;
                    }
                }
                // Watching is a subscription, not a scan. Each entity is registered with the one
                // live watcher, which keeps its own bounded set of repositories, debounces file
                // events and persists what it learns; the reply is whatever it already knows.
                // A repository it has not scanned yet simply has no snapshot to report, and the
                // next poll finds one, instead of this request walking 256 repositories in turn.
                for (const { entity } of tracked) options.git.track(entity);
                const wanted = new Set(
                    tracked.map(({ entity }) => `${entity.projectId}:${entity.workspaceId ?? ""}`),
                );
                sendJson(response, 200, {
                    snapshots: options.git
                        .liveSnapshots()
                        .filter((snapshot) =>
                            wanted.has(`${snapshot.projectId}:${snapshot.workspaceId ?? ""}`),
                        ),
                });
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
            return await options.files.resolveRoot(ctx, projectId, workspaceId);
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
