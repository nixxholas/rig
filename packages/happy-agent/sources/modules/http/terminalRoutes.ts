import {
    createTerminalInputSchema,
    resizeTerminalInputSchema,
    TerminalError,
    type TerminalScope,
} from "@slopus/happy-agent-modules";

import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRoute, type AgentHttpRouteGroup } from "./router.js";

export interface TerminalRouteOptions {
    readonly agent: StartedHappyAgent;
}

/**
 * Terminals on a project or one of its workspaces.
 *
 * Lifecycle is ordinary JSON: open one, list what is open, resize it, stop it. None of these
 * answers carries a screen. Watching a terminal and typing into it happen over the attachment the
 * daemon upgrades separately, because a screen is a stream, not a response body.
 */
export function createTerminalRoutes(options: TerminalRouteOptions): AgentHttpRouteGroup {
    return createRouteGroup("terminals", [
        ...collectionRoutes("/v0/projects/:projectId/terminals", (params) => ({
            projectId: params.projectId ?? "",
        })),
        ...terminalRoutes("/v0/projects/:projectId/terminals/:terminalId", (params) => ({
            projectId: params.projectId ?? "",
        })),
        ...collectionRoutes(
            "/v0/projects/:projectId/workspaces/:workspaceId/terminals",
            (params) => ({
                projectId: params.projectId ?? "",
                workspaceId: params.workspaceId ?? "",
            }),
        ),
        ...terminalRoutes(
            "/v0/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId",
            (params) => ({
                projectId: params.projectId ?? "",
                workspaceId: params.workspaceId ?? "",
            }),
        ),
    ]);

    function collectionRoutes(
        path: string,
        scopeOf: (params: Readonly<Record<string, string>>) => TerminalScope,
    ): readonly AgentHttpRoute[] {
        return [
            {
                method: "GET",
                path,
                handle: async ({ ctx, params, response }) => {
                    const terminals = await terminalRequest(
                        async () =>
                            await terminals$().list(
                                ctx,
                                scopeOf(params),
                            ),
                    );
                    sendJson(response, 200, { terminals });
                },
            },
            {
                method: "POST",
                path,
                handle: async ({ ctx, params, request, response }) => {
                    const body = await readValidatedBody(request, createTerminalInputSchema);
                    const terminal = await terminalRequest(
                        async () =>
                            await terminals$().create(
                                ctx,
                                scopeOf(params),
                                body,
                            ),
                    );
                    sendJson(response, 201, { terminal });
                },
            },
        ];
    }

    function terminalRoutes(
        path: string,
        scopeOf: (params: Readonly<Record<string, string>>) => TerminalScope,
    ): readonly AgentHttpRoute[] {
        return [
            {
                method: "PATCH",
                path,
                handle: async ({ ctx, params, request, response }) => {
                    const body = await readValidatedBody(request, resizeTerminalInputSchema);
                    const terminal = await terminalRequest(
                        async () =>
                            await terminals$().resize(
                                ctx,
                                scopeOf(params),
                                params.terminalId ?? "",
                                body,
                            ),
                    );
                    sendJson(response, 200, { terminal });
                },
            },
            {
                method: "DELETE",
                path,
                handle: async ({ ctx, params, response }) => {
                    const terminal = await terminalRequest(
                        async () =>
                            await terminals$().stop(
                                ctx,
                                scopeOf(params),
                                params.terminalId ?? "",
                            ),
                    );
                    sendJson(response, 200, { terminal });
                },
            },
        ];
    }

    function terminals$() {
        return options.agent.modules.terminals;
    }
}

/** Turns the module's own refusals into the status a client can act on. */
export async function terminalRequest<Result>(run: () => Promise<Result>): Promise<Result> {
    try {
        return await run();
    } catch (error) {
        throw terminalHttpError(error);
    }
}

export function terminalHttpError(error: unknown): unknown {
    if (!(error instanceof TerminalError)) return error;
    const status = {
        conflict: 409,
        invalid: 400,
        not_found: 404,
        unavailable: 503,
    }[error.code];
    return new AgentHttpError(status, error.message);
}
