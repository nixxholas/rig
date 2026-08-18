import type { IncomingMessage } from "node:http";

import { Type } from "@sinclair/typebox";
import type { Workspace } from "@slopus/happy-agent-modules";
import type { Context } from "@steve.kite/stdlib";

import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { workspaceWire } from "./workspaceWire.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import type { GitModule } from "@slopus/happy-agent-modules";

const createWorkspaceSchema = Type.Object(
    {
        baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        id: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
        /** The person this workspace is made for. One installation has exactly one. */
        identity: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        name: Type.String({ minLength: 1, maxLength: 500 }),
        nameConfigured: Type.Optional(Type.Boolean()),
        secret: Type.Optional(
            Type.Object({ kind: Type.Literal("github") }, { additionalProperties: false }),
        ),
        sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
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
    {
        afterId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 128 })]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
const emptySchema = Type.Object({}, { additionalProperties: false });

export interface WorkspaceRouteOptions {
    readonly agent: StartedHappyAgent;
    readonly git?: GitModule;
}

export function createWorkspaceRoutes(options: WorkspaceRouteOptions): AgentHttpRouteGroup {
    // Both catalogs directly: the workspaces catalog owns the rows and the checkouts, and the
    // projects catalog answers whether the project in the path exists at all.
    const catalog = options.agent.modules.workspaces;
    const projects = options.agent.modules.projects;
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
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/workspaces",
                    "projectId",
                );
                await requireProject(ctx, projectId);
                // A list is what the project has, not what it ever had. Archived rows are history
                // and only come back when the caller says so, and a workspace on its way out is
                // already gone as far as the project is concerned.
                const includeArchived = url.searchParams.get("includeArchived") === "true";
                const rows = (
                    await catalog.list(ctx, {
                        includeArchived: true,
                        projectRef: projectId,
                    })
                ).filter(
                    (row) =>
                        includeArchived ||
                        (row.status !== "archived" && row.status !== "archiving"),
                );
                sendJson(response, 200, { workspaces: rows.map((row) => workspaceWire(row)) });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/workspaces",
            handle: async ({ ctx, request, response, url }) => {
                assertEnabled();
                const projectId = pathParam(
                    url.pathname,
                    "/v0/projects/:projectId/workspaces",
                    "projectId",
                );
                await requireProject(ctx, projectId);
                const body = await readValidatedBody(request, createWorkspaceSchema);
                // Reservation is durable and immediate; the checkout runs behind it. The row that
                // comes back already carries the branch, folder and storage key Git will use, so
                // 202 means "this workspace exists and is being built", not "maybe".
                const workspace = await catalog.createWorkspace(
                    ctx,
                    projectId,
                    {
                        ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                        ...(body.id === undefined ? {} : { id: body.id }),
                        name: body.name,
                        ...(body.nameConfigured === undefined
                            ? {}
                            : { nameConfigured: body.nameConfigured }),
                        ...(body.secret === undefined ? {} : { secret: body.secret }),
                    },
                    body.sessionId,
                );
                if (workspace === undefined) {
                    throw new AgentHttpError(404, "The project was not found.");
                }
                await recordWorkspaceEvent(ctx, projectId, workspace, "workspace.created");
                sendJson(response, 202, { workspace: workspaceWire(workspace) });
            },
        },
        {
            method: "GET",
            path: "/v0/projects/:projectId/workspaces/:workspaceId",
            handle: async ({ ctx, response, url }) => {
                assertEnabled();
                const [projectId, workspaceId] = workspaceParams(url.pathname, "");
                await requireProject(ctx, projectId);
                sendJson(response, 200, {
                    workspace: workspaceWire(await requireWorkspace(ctx, projectId, workspaceId)),
                });
            },
        },
        {
            method: "PATCH",
            path: "/v0/projects/:projectId/workspaces/:workspaceId",
            handle: async ({ ctx, request, response, url }) => {
                assertEnabled();
                const [projectId, workspaceId] = workspaceParams(url.pathname, "");
                await requireProject(ctx, projectId);
                const expectedVersion = await expectVersion(ctx, request, projectId, workspaceId);
                const body = await readValidatedBody(request, renameWorkspaceSchema);
                // Renaming is the name plus the branch behind it: the catalog settles the name and
                // the recorded branch, and the host moves the Git ref afterwards without holding
                // the request while Git works.
                const workspace = await mutate(ctx, projectId, workspaceId, expectedVersion, () =>
                    catalog.rename(ctx, {
                        workspaceId,
                        name: body.name,
                        expectedVersion,
                    }),
                );
                await recordWorkspaceEvent(ctx, projectId, workspace, "workspace.updated", {
                    ...(body.mutationId === undefined ? {} : { mutationId: body.mutationId }),
                });
                sendJson(response, 200, { workspace: workspaceWire(workspace) });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/workspaces/:workspaceId/archive",
            handle: async ({ ctx, request, response, url }) => {
                assertEnabled();
                const [projectId, workspaceId] = workspaceParams(url.pathname, "/archive");
                await requireProject(ctx, projectId);
                const expectedVersion = await expectVersion(ctx, request, projectId, workspaceId);
                await readValidatedBody(request, emptySchema);
                // Archiving is durable the moment it is recorded. Removing the worktree is the
                // catalog's own background work: it can fail, be retried, or find the folder
                // already gone, and none of that gives the workspace back.
                const workspace = await mutate(ctx, projectId, workspaceId, expectedVersion, () =>
                    catalog.archive(ctx, workspaceId, { expectedVersion }),
                );
                // The folder is about to be removed, so the shells standing in it end here rather
                // than surviving into a directory that no longer exists.
                await options.agent.modules.terminals.closeScope({ projectId, workspaceId });
                await recordWorkspaceEvent(ctx, projectId, workspace, "workspace.updated");
                sendJson(response, 202, { workspace: workspaceWire(workspace) });
            },
        },
        {
            method: "POST",
            path: "/v0/projects/:projectId/workspaces/:workspaceId/reorder",
            handle: async ({ ctx, request, response, url }) => {
                assertEnabled();
                const [projectId, workspaceId] = workspaceParams(url.pathname, "/reorder");
                await requireProject(ctx, projectId);
                const expectedVersion = await expectVersion(ctx, request, projectId, workspaceId);
                const body = await readValidatedBody(request, reorderSchema);
                const workspace = await mutate(ctx, projectId, workspaceId, expectedVersion, () =>
                    catalog.reorder(ctx, {
                        workspaceId,
                        afterId: body.afterId,
                        expectedVersion,
                    }),
                );
                await recordWorkspaceEvent(ctx, projectId, workspace, "workspace.updated", {
                    ...(body.mutationId === undefined ? {} : { mutationId: body.mutationId }),
                });
                sendJson(response, 200, { workspace: workspaceWire(workspace) });
            },
        },
    ]);

    async function requireProject(ctx: Context, projectId: string): Promise<void> {
        if ((await projects.get(ctx, projectId)) === undefined) {
            throw new AgentHttpError(404, "The project was not found.");
        }
    }

    /** One workspace, but only when it is the named project's. */
    async function findWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        const workspace = await catalog.get(ctx, workspaceId);
        return workspace?.projectRef === projectId ? workspace : undefined;
    }

    async function requireWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace> {
        const workspace = await findWorkspace(ctx, projectId, workspaceId);
        if (workspace === undefined) {
            throw new AgentHttpError(404, "The workspace was not found.");
        }
        return workspace;
    }

    /** Reads `If-Match` as the row's version and answers 409 before doing any work when stale. */
    async function expectVersion(
        ctx: Context,
        request: IncomingMessage,
        projectId: string,
        workspaceId: string,
    ): Promise<number> {
        const current = await requireWorkspace(ctx, projectId, workspaceId);
        const header = request.headers["if-match"];
        if (typeof header !== "string") {
            throw new AgentHttpError(400, "The workspace version is invalid.");
        }
        const parsed = Number.parseInt(header.trim().replace(/^W\/|"/g, ""), 10);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
            throw new AgentHttpError(400, "The workspace version is invalid.");
        }
        if (parsed !== current.version) {
            throw new AgentHttpError(409, "The workspace has changed.", {
                currentVersion: current.version,
                workspace: workspaceWire(current),
            });
        }
        return parsed;
    }

    /**
     * Runs one guarded mutation and turns a lost race into the authoritative row.
     *
     * The module compares the expected version inside its own transaction, so a failure can mean
     * a conflict or a real error. Re-reading the row tells them apart without matching a message.
     */
    async function mutate(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        expectedVersion: number,
        run: () => Promise<Workspace | undefined>,
    ): Promise<Workspace> {
        let updated: Workspace | undefined;
        try {
            updated = await run();
        } catch (error) {
            const now = await findWorkspace(ctx, projectId, workspaceId);
            if (now !== undefined && now.version !== expectedVersion) {
                throw new AgentHttpError(409, "The workspace has changed.", {
                    currentVersion: now.version,
                    workspace: workspaceWire(now),
                });
            }
            throw error;
        }
        if (updated === undefined) throw new AgentHttpError(404, "The workspace was not found.");
        return updated;
    }

    /**
     * Announces a committed change without letting the journal undo it. A client that misses the
     * notification re-reads and finds the truth; one told the mutation failed would be wrong.
     */
    async function recordWorkspaceEvent(
        ctx: Context,
        projectId: string,
        workspace: Workspace,
        type: "workspace.created" | "workspace.updated",
        extra: Record<string, unknown> = {},
    ): Promise<void> {
        try {
            await options.agent.modules.events.record(ctx, {
                payload: {
                    projectId,
                    workspaceId: workspace.id,
                    workspace: workspaceWire(workspace),
                    ...extra,
                },
                type,
            });
        } catch (error) {
            ctx.log.warn(
                "A committed workspace change was not announced to clients.",
                { projectId, type, workspaceId: workspace.id },
                error,
            );
        }
    }
}

function workspaceParams(pathname: string, suffix: string): [string, string] {
    const template = `/v0/projects/:projectId/workspaces/:workspaceId${suffix}`;
    return [
        pathParam(pathname, template, "projectId"),
        pathParam(pathname, template, "workspaceId"),
    ];
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
