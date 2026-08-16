import type { IncomingMessage } from "node:http";

import { Type } from "@sinclair/typebox";
import { projectRemoteSourceSchema, type Project } from "@slopus/happy-agent-modules";
import type { Context } from "@steve.kite/stdlib";

import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { ProjectRegistrationError } from "../projects/ProjectRegistrationError.js";
import type { ProjectWorkspaceService } from "../projects/ProjectWorkspaceService.js";
import type { GitModule } from "../git/GitModule.js";
import type { ProjectFilesModule } from "../files/ProjectFilesModule.js";

const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;

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
        // The catalog only accepts an `owner/name` repository and a plain HTTPS remote with no
        // credentials in it, and the clone boundary will only run that. Validating the same shape
        // here turns a remote nobody can clone into a clear refusal instead of a failed project.
        source: projectRemoteSourceSchema,
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
    {
        afterId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 128 })]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
const emptySchema = Type.Object({}, { additionalProperties: false });

export interface ProjectRouteOptions {
    readonly agent: LoadedHappyAgent;
    readonly files?: ProjectFilesModule;
    readonly git?: GitModule;
    readonly projects: ProjectWorkspaceService;
}

export function createProjectRoutes(options: ProjectRouteOptions): AgentHttpRouteGroup {
    const projects = options.projects;
    const agentId = options.agent.agent.id;
    const catalog = options.agent.modules.projects;
    return createRouteGroup("projects", [
        {
            method: "GET",
            path: "/v0/projects",
            handle: async ({ ctx, response }) => {
                const rows = await projects.listProjects(ctx);
                sendJson(response, 200, {
                    projects: await Promise.all(rows.map(async (row) => await toProject(ctx, row))),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/projects",
            handle: async ({ ctx, request, response }) => {
                const body = await readValidatedBody(request, registerProjectSchema);
                const project = await registration(async () => {
                    const registered = await projects.registerProject(ctx, {
                        path: body.path,
                        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
                    });
                    await recordProjectEvent(
                        ctx,
                        options.agent,
                        registered.id,
                        "project.created",
                        { project: await toProject(ctx, registered) },
                    );
                    return registered;
                });
                sendJson(response, 200, { project: await toProject(ctx, project) });
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
                // The whole clone — staging folder, credentials, origin proof, the move into the
                // managed folder — belongs to the host. The route's part is to hand over what the
                // person asked for, including the credential kind, and to say where it landed.
                const project = await registration(
                    async () =>
                        await projects.createRemoteProject(ctx, {
                            name: body.name,
                            ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
                            ...(body.secret === undefined ? {} : { secret: body.secret }),
                            source:
                                body.source.kind === "github"
                                    ? { kind: "github", repository: body.source.repository }
                                    : { kind: "git", url: body.source.url },
                        }),
                );
                await recordProjectEvent(ctx, options.agent, project.id, "project.created", {
                    project: await toProject(ctx, project),
                });
                sendJson(response, 202, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "GET",
            path: "/v0/projects/:projectId",
            handle: async ({ ctx, response, url }) => {
                const projectId = pathParam(url.pathname, "/v0/projects/:projectId", "projectId");
                const project = await requireProject(ctx, projectId);
                sendJson(response, 200, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "PATCH",
            path: "/v0/projects/:projectId",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = pathParam(url.pathname, "/v0/projects/:projectId", "projectId");
                const expectedVersion = await expectVersion(ctx, request, projectId);
                const body = await readValidatedBody(request, renameProjectSchema);
                const project = await mutate(ctx, projectId, expectedVersion, async () => {
                    return await projects.renameProject(
                        ctx,
                        projectId,
                        body.name,
                        expectedVersion,
                    );
                });
                await recordProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    ...(body.mutationId === undefined ? {} : { mutationId: body.mutationId }),
                    project: await toProject(ctx, project),
                });
                sendJson(response, 200, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "PUT",
            path: "/v0/projects/:projectId/settings",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/settings",
                    "projectId",
                );
                const expectedVersion = await expectVersion(ctx, request, projectId);
                const body = await readValidatedBody(request, settingsSchema);
                const project = await mutate(ctx, projectId, expectedVersion, async () => {
                    return await projects.setProjectSettings(
                        ctx,
                        projectId,
                        body.defaultWorkspaceCompute === undefined
                            ? {}
                            : { defaultWorkspaceCompute: body.defaultWorkspaceCompute },
                        expectedVersion,
                    );
                });
                const settings = await catalog.readSettings(ctx, agentId, projectId);
                await recordProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    ...(body.mutationId === undefined ? {} : { mutationId: body.mutationId }),
                    project: await toProject(ctx, project),
                });
                sendJson(response, 200, { project: await toProject(ctx, project), settings });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/refresh",
            handle: async ({ ctx, response, url }) => {
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/refresh",
                    "projectId",
                );
                // Refresh really re-runs setup: the row goes back to initializing and the host
                // starts the work again. The answer is 202 because the work outlives the request.
                const project = await registration(async () => {
                    const refreshed = await projects.refreshProject(ctx, projectId);
                    if (refreshed === undefined) {
                        throw new AgentHttpError(404, "The project was not found.");
                    }
                    return refreshed;
                });
                await recordProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    project: await toProject(ctx, project),
                });
                sendJson(response, 202, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/reorder",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/reorder",
                    "projectId",
                );
                const expectedVersion = await expectVersion(ctx, request, projectId);
                const body = await readValidatedBody(request, reorderSchema);
                const project = await mutate(ctx, projectId, expectedVersion, async () => {
                    return await projects.reorderProject(
                        ctx,
                        projectId,
                        body.afterId,
                        expectedVersion,
                    );
                });
                await recordProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    ...(body.mutationId === undefined ? {} : { mutationId: body.mutationId }),
                    project: await toProject(ctx, project),
                });
                sendJson(response, 200, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/archive",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/archive",
                    "projectId",
                );
                await expectVersion(ctx, request, projectId);
                await readValidatedBody(request, emptySchema);
                // Archival is the decision; removing the workspaces' folders is background work
                // the host owns. The 202 says exactly that: the row is already archived.
                const project = await projects.archiveProject(ctx, projectId);
                if (project === undefined) {
                    throw new AgentHttpError(404, "The project was not found.");
                }
                await recordProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    project: await toProject(ctx, project),
                });
                sendJson(response, 202, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "PUT",
            path: "/v0/projects/:projectId/avatar",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/avatar",
                    "projectId",
                );
                const expectedVersion = await expectVersion(ctx, request, projectId);
                const bytes = await readImageBody(request);
                const project = await mutate(ctx, projectId, expectedVersion, async () => {
                    return await projects.setAvatar(
                        ctx,
                        projectId,
                        "user",
                        bytes,
                        expectedVersion,
                    );
                });
                await recordProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    project: await toProject(ctx, project),
                });
                sendJson(response, 200, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "DELETE",
            path: "/v0/projects/:projectId/avatar",
            handle: async ({ ctx, request, response, url }) => {
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/avatar",
                    "projectId",
                );
                const expectedVersion = await expectVersion(ctx, request, projectId);
                const project = await mutate(ctx, projectId, expectedVersion, async () => {
                    return await projects.clearAvatar(ctx, projectId);
                });
                await recordProjectEvent(ctx, options.agent, projectId, "project.updated", {
                    project: await toProject(ctx, project),
                });
                sendJson(response, 200, { project: await toProject(ctx, project) });
            },
        },
        {
            method: "GET",
            path: "/v0/project-assets/:assetHash",
            handle: async ({ ctx, response, url }) => {
                await sendAvatar(ctx, response, url.pathname.split("/").at(-1) ?? "");
            },
        },
        {
            method: "GET",
            path: "/v0/projects/avatars/:assetHash",
            handle: async ({ ctx, response, url }) => {
                await sendAvatar(ctx, response, url.pathname.split("/").at(-1) ?? "");
            },
        },
    ]);

    async function sendAvatar(
        ctx: Context,
        response: import("node:http").ServerResponse,
        hash: string,
    ): Promise<void> {
        if (!/^[0-9a-f]{64}$/.test(hash)) {
            throw new AgentHttpError(404, "The project asset was not found.");
        }
        const asset = await projects.avatarAsset(ctx, hash);
        if (asset === undefined) {
            throw new AgentHttpError(404, "The project asset was not found.");
        }
        response.writeHead(200, {
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": asset.mediaType,
            etag: `"${hash}"`,
        });
        response.end(Buffer.from(asset.bytes));
    }

    async function requireProject(ctx: Context, projectId: string): Promise<Project> {
        const project = await projects.getProject(ctx, projectId);
        if (project === undefined) throw new AgentHttpError(404, "The project was not found.");
        return project;
    }

    /**
     * Reads `If-Match` and answers before doing any work when it is already stale.
     *
     * The header is a version, not a timestamp, and the same number is handed to the mutation so
     * the real check happens inside the module's transaction. This up-front read only turns the
     * common case into a 409 that carries the row the client is missing.
     */
    async function expectVersion(
        ctx: Context,
        request: IncomingMessage,
        projectId: string,
    ): Promise<number> {
        const current = await requireProject(ctx, projectId);
        const header = request.headers["if-match"];
        if (typeof header !== "string") {
            throw new AgentHttpError(400, "The project version is invalid.");
        }
        const parsed = Number.parseInt(header.trim().replace(/^W\/|"/g, ""), 10);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
            throw new AgentHttpError(400, "The project version is invalid.");
        }
        if (parsed !== current.version) {
            throw new AgentHttpError(409, "The project has changed.", {
                currentVersion: current.version,
                project: await toProject(ctx, current),
            });
        }
        return parsed;
    }

    /**
     * Runs one guarded mutation and turns a lost race into the authoritative row.
     *
     * The module compares the expected version inside its own transaction, so a failure here can
     * mean either a conflict or a real error. Re-reading the row is what tells them apart without
     * matching on a message: a row that moved on is a 409 with what it says now.
     */
    async function mutate(
        ctx: Context,
        projectId: string,
        expectedVersion: number,
        run: () => Promise<Project | undefined>,
    ): Promise<Project> {
        let updated: Project | undefined;
        try {
            updated = await run();
        } catch (error) {
            if (error instanceof AgentHttpError) throw error;
            const now = await projects.getProject(ctx, projectId);
            if (now !== undefined && now.version !== expectedVersion) {
                throw new AgentHttpError(409, "The project has changed.", {
                    currentVersion: now.version,
                    project: await toProject(ctx, now),
                });
            }
            throw registrationError(error);
        }
        if (updated === undefined) throw new AgentHttpError(404, "The project was not found.");
        return updated;
    }

    /**
     * Records what a mutation did without letting the journal undo it.
     *
     * The row is already committed by the time this runs. A client that misses the notification
     * re-reads and finds the truth; a client told the whole mutation failed would be wrong.
     */
    async function recordProjectEvent(
        ctx: Context,
        agent: LoadedHappyAgent,
        projectId: string,
        type: "project.created" | "project.updated",
        payload: Record<string, unknown>,
    ): Promise<void> {
        try {
            await agent.modules.events.record(ctx, {
                agentId: agent.agent.id,
                payload: { projectId, ...payload },
                type,
            });
        } catch (error) {
            ctx.log.warn(
                "A committed project change was not announced to clients.",
                { projectId, type },
                error,
            );
        }
    }

    /** The wire form of one project. Every field comes from the record, none is invented. */
    async function toProject(ctx: Context, project: Project): Promise<Record<string, unknown>> {
        const settings = await catalog.readSettings(ctx, agentId, project.id).catch(() => ({}));
        return {
            archivedAt: project.archivedAt,
            avatar: project.avatar,
            createdAt: project.createdAt,
            defaultBranch: project.defaultBranch,
            description: project.description,
            git: {
                ahead: project.gitAhead,
                behind: project.gitBehind,
                branch: project.gitBranch,
                detached: project.gitDetached,
                head: project.gitHead,
                upstream: project.gitUpstream,
            },
            id: project.id,
            initializationAttempt: project.initializationAttempt,
            initializationError: project.initializationError,
            initializationStatus: project.initializationStatus,
            kind: project.kind,
            name: project.name,
            nameSource: project.nameSource,
            orderKey: project.orderKey,
            path: project.repositoryRef,
            presence: project.presence,
            remoteSource: project.remoteSource,
            requiredSecretKind: project.requiredSecretKind,
            settings,
            status: project.status,
            storageKey: project.storageKey,
            updatedAt: project.updatedAt,
            version: project.version,
            worktreeSupport: project.worktreeSupport,
            worktreeUnsupportedReason: project.worktreeUnsupportedReason,
        };
    }
}

/** Keeps the host's typed refusals as the codes v1 clients already show a person. */
async function registration<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw registrationError(error);
    }
}

function registrationError(error: unknown): unknown {
    if (error instanceof AgentHttpError) return error;
    if (error instanceof ProjectRegistrationError) {
        return new AgentHttpError(400, error.message, { code: error.code });
    }
    return error;
}

function pathParam(pathname: string, template: string, name: string): string {
    const actual = pathname.split("/").filter(Boolean);
    const expected = template.split("/").filter(Boolean);
    if (actual.length !== expected.length) throw new AgentHttpError(404, "Route not found.");
    let found: string | undefined;
    expected.forEach((value, index) => {
        if (!value.startsWith(":")) {
            if (value !== actual[index]) throw new AgentHttpError(404, "Route not found.");
            return;
        }
        if (value.slice(1) === name) found = decodeURIComponent(actual[index] ?? "");
    });
    if (found === undefined || found.length === 0) {
        throw new AgentHttpError(404, "Route not found.");
    }
    return found;
}

/** Reads an avatar upload, refusing anything past the limit rather than buffering it. */
async function readImageBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += buffer.byteLength;
        if (total > MAX_AVATAR_UPLOAD_BYTES) {
            throw new AgentHttpError(413, "The project image is larger than the allowed limit.");
        }
        chunks.push(buffer);
    }
    if (total === 0) throw new AgentHttpError(400, "The project image is empty.");
    return Buffer.concat(chunks);
}
