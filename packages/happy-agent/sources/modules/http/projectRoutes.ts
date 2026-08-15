import { basename, join } from "node:path";
import { stat } from "node:fs/promises";

import { Type, type Static } from "@sinclair/typebox";

import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import {
    assertGitTopLevel,
    canonicalProjectDirectory,
    createLocalProjectWorkspaceHost,
    type ProjectWorkspaceHost,
} from "../projects/ProjectHost.js";
import type { GitModule } from "../git/GitModule.js";
import type { ProjectFilesModule } from "../files/ProjectFilesModule.js";

const registerProjectSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 16_384 }),
        projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
);
const cloneProjectSchema = Type.Object(
    {
        identity: Type.String({ minLength: 1, maxLength: 256 }),
        name: Type.String({ minLength: 1, maxLength: 100, pattern: "^[^/\\\\\\u0000]+$" }),
        projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        secret: Type.Optional(
            Type.Object({ kind: Type.Literal("github") }, { additionalProperties: false }),
        ),
        source: Type.Union([
            Type.Object(
                {
                    kind: Type.Literal("github"),
                    repository: Type.String({ minLength: 1, maxLength: 512 }),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                { kind: Type.Literal("git"), url: Type.String({ minLength: 1, maxLength: 2_048 }) },
                { additionalProperties: false },
            ),
        ]),
    },
    { additionalProperties: false },
);
const renameProjectSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        name: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
);
const settingsSchema = Type.Object(
    {
        defaultWorkspaceCompute: Type.Optional(
            Type.Union([
                Type.Object({ type: Type.Literal("local") }, { additionalProperties: false }),
                Type.Object(
                    {
                        image: Type.String({ minLength: 1, maxLength: 512 }),
                        type: Type.Literal("docker"),
                    },
                    { additionalProperties: false },
                ),
            ]),
        ),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
const reorderSchema = Type.Object(
    { afterId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 128 })]) },
    { additionalProperties: false },
);
const emptySchema = Type.Object({}, { additionalProperties: false });

type RegisterProject = Static<typeof registerProjectSchema>;

export interface ProjectRouteOptions {
    readonly agent: LoadedHappyAgent;
    readonly files?: ProjectFilesModule;
    readonly git?: GitModule;
    readonly host?: ProjectWorkspaceHost;
}

export function createProjectRoutes(options: ProjectRouteOptions): AgentHttpRouteGroup {
    const host = options.host ?? createLocalProjectWorkspaceHost();
    const agentId = options.agent.agent.id;
    const projects = options.agent.modules.projects;
    return createRouteGroup("projects", [
        {
            method: "GET",
            path: "/v0/projects",
            handle: async ({ ctx, response }) => {
                const rows = await projects.list(ctx, agentId, { includeArchived: true });
                sendJson(response, 200, {
                    projects: await Promise.all(rows.map((row) => toProject(row))),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/projects",
            handle: async ({ ctx, request, response }) => {
                const body = await readValidatedBody(request, registerProjectSchema);
                const project = await registerProject(ctx, body);
                sendJson(response, 200, { project: await toProject(project) });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/clone",
            handle: async ({ ctx, request, response }) => {
                const body = await readValidatedBody(request, cloneProjectSchema);
                if (body.identity !== agentId) {
                    throw new AgentHttpError(403, "The clone identity does not match this agent.");
                }
                if (body.secret !== undefined && body.source.kind !== "github") {
                    throw projectRegistrationError(
                        "unsupported_git_source",
                        "GitHub credentials require a GitHub source.",
                    );
                }
                if (host.cloneRemote === undefined) {
                    throw new AgentHttpError(503, "Remote project cloning is unavailable.");
                }
                const destination = join(options.agent.publicHome, "Projects", body.name);
                await host.cloneRemote(ctx, {
                    destination,
                    source:
                        body.source.kind === "github"
                            ? { kind: "github", repository: body.source.repository }
                            : { kind: "git", url: body.source.url },
                });
                const project = await registerProject(ctx, {
                    path: destination,
                    ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
                });
                sendJson(response, 202, { project: await toProject(project) });
            },
        },
        {
            method: "GET",
            path: "/v0/projects/:projectId",
            handle: async ({ ctx, response, url }) => {
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId"),
                    "projectId",
                );
                const project = await projects.get(ctx, agentId, projectId);
                if (project === undefined)
                    throw new AgentHttpError(404, "The project was not found.");
                sendJson(response, 200, { project: await toProject(project) });
            },
        },
        {
            method: "PATCH",
            path: "/v0/projects/:projectId",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId"),
                    "projectId",
                );
                const current = await requireProject(ctx, projectId);
                assertVersion(request.headers["if-match"], current.updatedAt, "project");
                const body = await readValidatedBody(request, renameProjectSchema);
                const project = await projects.rename(ctx, agentId, projectId, { name: body.name });
                await emitProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    mutationId: body.mutationId,
                    project: await toProject(project),
                });
                sendJson(response, 200, { project: await toProject(project) });
            },
        },
        {
            method: "PUT",
            path: "/v0/projects/:projectId/settings",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId/settings"),
                    "projectId",
                );
                const current = await requireProject(ctx, projectId);
                assertVersion(request.headers["if-match"], current.updatedAt, "project");
                const body = await readValidatedBody(request, settingsSchema);
                const settings =
                    body.defaultWorkspaceCompute === undefined
                        ? {}
                        : { defaultWorkspaceCompute: body.defaultWorkspaceCompute };
                const result = await projects.updateSettings(ctx, agentId, projectId, settings);
                const project = await requireProject(ctx, projectId);
                await emitProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    mutationId: body.mutationId,
                    project: await toProject(project),
                });
                sendJson(response, 200, {
                    project: await toProject(project),
                    settings: result.settings,
                });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/refresh",
            handle: async ({ ctx, response, url }) => {
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId/refresh"),
                    "projectId",
                );
                const project = await requireProject(ctx, projectId);
                sendJson(response, 202, { project: await toProject(project) });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/reorder",
            handle: async ({ request }) => {
                await readValidatedBody(request, reorderSchema);
                throw new AgentHttpError(
                    503,
                    "Project ordering is not available in the Happy Agent host.",
                );
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/archive",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = requireParam(
                    requireParams(url.pathname, "/v0/projects/:projectId/archive"),
                    "projectId",
                );
                const current = await requireProject(ctx, projectId);
                assertVersion(request.headers["if-match"], current.updatedAt, "project");
                await readValidatedBody(request, emptySchema);
                const project = await projects.archive(ctx, agentId, projectId);
                await emitProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    project: await toProject(project),
                });
                sendJson(response, 202, { project: await toProject(project) });
            },
        },
        {
            method: "PUT",
            path: "/v0/projects/:projectId/avatar",
            handle: async ({ request }) => {
                await drainRequest(request);
                throw new AgentHttpError(
                    503,
                    "Project avatars are not available in the Happy Agent host.",
                );
            },
        },
        {
            method: "DELETE",
            path: "/v0/projects/:projectId/avatar",
            handle: async () => {
                throw new AgentHttpError(
                    503,
                    "Project avatars are not available in the Happy Agent host.",
                );
            },
        },
        {
            method: "GET",
            path: "/v0/project-assets/:assetHash",
            handle: async ({ response, url }) => {
                const hash = url.pathname.split("/").at(-1) ?? "";
                if (!/^[0-9a-f]{64}$/.test(hash) || host.asset === undefined) {
                    throw new AgentHttpError(404, "The project asset was not found.");
                }
                const asset = await host.asset(hash);
                if (asset === undefined)
                    throw new AgentHttpError(404, "The project asset was not found.");
                response.writeHead(200, {
                    "cache-control": "public, max-age=31536000, immutable",
                    "content-type": asset.mediaType,
                    etag: `"${hash}"`,
                });
                response.end(asset.body);
            },
        },
    ]);

    async function registerProject(
        ctx: import("@steve.kite/stdlib").Context,
        body: RegisterProject,
    ) {
        const canonical = await canonicalProjectDirectory(body.path).catch((error: unknown) => {
            throw projectRegistrationError(
                "path_missing",
                error instanceof Error ? error.message : "The project folder does not exist.",
            );
        });
        await assertGitTopLevel(host, canonical).catch((error: unknown) => {
            throw projectRegistrationError(
                "not_git_repository",
                error instanceof Error
                    ? error.message
                    : "The project folder is not a Git repository.",
            );
        });
        const name = basename(canonical);
        try {
            const existing = (await projects.list(ctx, agentId, { includeArchived: true })).find(
                (candidate) => candidate.repositoryRef === canonical,
            );
            if (existing !== undefined) {
                if (body.projectId !== undefined && existing.id !== body.projectId) {
                    throw projectRegistrationError(
                        "project_id_conflict",
                        "The project ID is already in use.",
                    );
                }
                return existing;
            }
            const project =
                body.projectId === undefined
                    ? (
                          await projects.ensure(ctx, agentId, {
                              name,
                              repositoryRef: canonical,
                          })
                      ).project
                    : await projects.create(ctx, agentId, {
                          id: body.projectId,
                          name,
                          repositoryRef: canonical,
                      });
            await emitProjectEvent(ctx, options.agent, project.id, "project.created", {
                project: await toProject(project),
            });
            return project;
        } catch (error) {
            if (error instanceof AgentHttpError) throw error;
            throw projectRegistrationError("project_path_conflict", errorMessage(error));
        }
    }

    async function requireProject(ctx: import("@steve.kite/stdlib").Context, projectId: string) {
        const project = await projects.get(ctx, agentId, projectId);
        if (project === undefined) throw new AgentHttpError(404, "The project was not found.");
        return project;
    }

    async function toProject(
        project: Awaited<ReturnType<typeof projects.get>> extends infer T
            ? Exclude<T, undefined>
            : never,
    ) {
        let present = false;
        try {
            present = (await stat(project.repositoryRef)).isDirectory();
        } catch {
            present = false;
        }
        return {
            archivedAt: project.archivedAt,
            createdAt: project.createdAt,
            defaultBranch: undefined,
            git: undefined,
            id: project.id,
            initializationAttempt: 1,
            initializationStatus: "ready" as const,
            kind: "regular" as const,
            name: project.name,
            nameSource: "user" as const,
            orderKey: project.id,
            path: project.repositoryRef,
            presence: present ? ("present" as const) : ("missing" as const),
            settings: { defaultWorkspaceCompute: { type: "local" as const, generation: 0 } },
            storageKey: project.repositoryRef,
            updatedAt: project.updatedAt,
            version: project.updatedAt,
            worktreeSupport: "unknown" as const,
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
    if (!Number.isSafeInteger(parsed) || (parsed as number) < 0 || parsed !== current) {
        if (parsed !== current)
            throw new AgentHttpError(409, `The ${entity} has changed.`, {
                currentVersion: current,
            });
        throw new AgentHttpError(400, `The ${entity} version is invalid.`);
    }
}

async function emitProjectEvent(
    ctx: import("@steve.kite/stdlib").Context,
    agent: LoadedHappyAgent,
    projectId: string,
    type: "project.created" | "project.updated",
    payload: Record<string, unknown>,
): Promise<void> {
    await agent.modules.events.record(ctx, {
        agentId: agent.agent.id,
        payload: { projectId, ...payload },
        type,
    });
}

function projectRegistrationError(code: string, message: string): AgentHttpError {
    return new AgentHttpError(400, message, { code });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "The project operation failed.";
}

async function drainRequest(request: import("node:http").IncomingMessage): Promise<void> {
    for await (const _chunk of request) {
        // Consume the body before returning the error so the keep-alive socket remains usable.
    }
}
