import type { SessionInputBlock, SessionUserMessage } from "@slopus/happy-providers";

import { readValidatedBody } from "./body.js";
import { sendJson } from "./errors.js";
import {
    awaitRequestSchema,
    messageRequestSchema,
    metadataRequestSchema,
    type MessageRequest,
} from "./HttpSchemas.js";
import { mergeAgentMessageOptions } from "./agentMessageOptions.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

export function createAgentRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("agent", [
        {
            method: "GET",
            path: "/v0/agent",
            handle: async ({ ctx, dependencies, response }) => {
                const { agent, system, modules } = dependencies.agent;
                sendJson(response, 200, {
                    active: agent.active,
                    config: await system.config(ctx, agent.id),
                    eventCursor: modules.events.cursor(),
                    id: agent.id,
                    modules: Object.values(modules).map((module) => module.name),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/agent/messages",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, messageRequestSchema);
                const acceptance = await dependencies.agent.system.send(
                    ctx,
                    dependencies.agent.agent.id,
                    messageFromRequest(body),
                    mergeAgentMessageOptions(
                        dependencies.agent.effectiveSelection,
                        dependencies.agent.system.models,
                        {
                            ...(body.await === undefined ? {} : { await: body.await }),
                            ...(body.effort === undefined ? {} : { effort: body.effort }),
                            ...(body.id === undefined ? {} : { id: body.id }),
                            ...(body.model === undefined ? {} : { model: body.model }),
                            ...(body.permissionMode === undefined
                                ? {}
                                : { permissionMode: body.permissionMode }),
                            ...(body.provider === undefined ? {} : { provider: body.provider }),
                            ...(body.serviceTier === undefined
                                ? {}
                                : { serviceTier: body.serviceTier }),
                        },
                    ),
                );
                sendJson(response, 202, acceptance);
            },
        },
        {
            method: "POST",
            path: "/v0/steering",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, messageRequestSchema);
                const acceptance = await dependencies.agent.system.steer(
                    ctx,
                    dependencies.agent.agent.id,
                    messageFromRequest(body),
                    mergeAgentMessageOptions(
                        dependencies.agent.effectiveSelection,
                        dependencies.agent.system.models,
                        {
                            ...(body.await === undefined ? {} : { await: body.await }),
                            ...(body.effort === undefined ? {} : { effort: body.effort }),
                            ...(body.id === undefined ? {} : { id: body.id }),
                            ...(body.model === undefined ? {} : { model: body.model }),
                            ...(body.permissionMode === undefined
                                ? {}
                                : { permissionMode: body.permissionMode }),
                            ...(body.provider === undefined ? {} : { provider: body.provider }),
                            ...(body.serviceTier === undefined
                                ? {}
                                : { serviceTier: body.serviceTier }),
                        },
                    ),
                );
                sendJson(response, 202, acceptance);
            },
        },
        {
            method: "POST",
            path: "/v0/abort",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, awaitRequestSchema);
                await dependencies.agent.system.abort(ctx, dependencies.agent.agent.id, body);
                sendJson(response, 202, { accepted: true });
            },
        },
        {
            method: "POST",
            path: "/v0/compact",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, awaitRequestSchema);
                await dependencies.agent.system.compact(ctx, dependencies.agent.agent.id, body);
                sendJson(response, 202, { accepted: true });
            },
        },
        {
            method: "PATCH",
            path: "/v0/agent/metadata",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, metadataRequestSchema);
                await dependencies.agent.system.updateMetadata(
                    ctx,
                    dependencies.agent.agent.id,
                    body,
                );
                sendJson(response, 200, {
                    config: await dependencies.agent.system.config(
                        ctx,
                        dependencies.agent.agent.id,
                    ),
                    id: dependencies.agent.agent.id,
                });
            },
        },
    ]);
}

function messageFromRequest(request: MessageRequest): SessionUserMessage {
    const content: readonly SessionInputBlock[] =
        typeof request.content === "string"
            ? [{ text: request.content, type: "text" }]
            : request.content;
    return { content, role: "user" };
}
