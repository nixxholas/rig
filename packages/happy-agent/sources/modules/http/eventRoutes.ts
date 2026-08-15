import type { IncomingMessage, ServerResponse } from "node:http";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { readValidatedBody, parsePositiveLimit } from "./body.js";
import { AgentHttpError, sendJson, serializeJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { createSseWriter } from "./sseWriter.js";
import { happyAgentEventIdSchema, type HappyAgentEvent } from "../events/EventsModule.js";

const timelineSchema = Type.Object(
    {
        includeArchived: Type.Optional(Type.Boolean()),
        since: Type.Optional(Type.Integer({ minimum: 0 })),
        scope: Type.Union([
            Type.Object({ kind: Type.Literal("global") }, { additionalProperties: false }),
            Type.Object(
                { kind: Type.Literal("project"), projectId: Type.String({ minLength: 1 }) },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    kind: Type.Literal("workspace"),
                    projectId: Type.String({ minLength: 1 }),
                    workspaceId: Type.String({ minLength: 1 }),
                },
                { additionalProperties: false },
            ),
            Type.Object(
                { kind: Type.Literal("session"), sessionId: Type.String({ minLength: 1 }) },
                { additionalProperties: false },
            ),
        ]),
    },
    { additionalProperties: false },
);
const trimSchema = Type.Object(
    {
        through: Type.String({
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        }),
    },
    { additionalProperties: false },
);

const SSE_HEARTBEAT_MS = 15_000;
const MAX_PENDING_BYTES = 1_024 * 1_024;

export function createEventRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("events", [
        {
            method: "GET",
            path: "/v0/catalog",
            handle: async ({ dependencies, response }) => {
                const cursor = dependencies.agent.modules.events.cursor();
                sendJson(response, 200, {
                    catalog: {
                        defaultModelId: dependencies.agent.system.models[0]?.id ?? "",
                        defaultProviderId: dependencies.agent.system.models[0]?.providerId ?? "",
                        models: dependencies.agent.system.models,
                        providers: groupModels(dependencies.agent.system.models),
                    },
                    cursor,
                    folderItems: [],
                    folders: [],
                    identity: { version: dependencies.version ?? "0.0.0" },
                    presence: { kind: "unavailable", reason: "not_configured" },
                    projects: [],
                    protocolVersion: 0,
                    sessions: [],
                    sessionsComplete: true,
                    terminalGroups: [],
                    workspaces: [],
                });
            },
        },
        {
            method: "POST",
            path: "/v0/timeline",
            handle: async ({ dependencies, request, response }) => {
                const body = await readValidatedBody(request, timelineSchema);
                if (body.scope.kind !== "global") {
                    throw new AgentHttpError(
                        503,
                        "Project, workspace, and session timeline hosts are not configured.",
                    );
                }
                sendJson(response, 200, {
                    agents: [],
                    cursor: dependencies.agent.modules.events.cursor(),
                    scope: body.scope,
                });
            },
        },
        {
            method: "GET",
            path: "/v0/events",
            handle: async ({ dependencies, response, url }) => {
                const after = url.searchParams.get("after") ?? undefined;
                if (after !== undefined && !Value.Check(happyAgentEventIdSchema, after)) {
                    throw new AgentHttpError(400, "The event cursor must be a UUIDv7 value.");
                }
                const limit = parsePositiveLimit(
                    url.searchParams.get("limit"),
                    100,
                    dependencies.agent.modules.events.capacity(),
                );
                const replay = dependencies.agent.modules.events.replay(after, limit);
                if (replay === undefined) {
                    throw new AgentHttpError(409, "Event cursor is unavailable.", {
                        cursor: dependencies.agent.modules.events.cursor(),
                    });
                }
                sendJson(response, 200, replay);
            },
        },
        {
            method: "GET",
            path: "/v0/events/live",
            handle: async ({ dependencies, request, response, url }) => {
                await streamEvents(
                    request,
                    response,
                    dependencies.agent.modules.events,
                    cursorFromRequest(request, url),
                    "live",
                    dependencies.agent.agent.id,
                );
            },
        },
        {
            method: "GET",
            path: "/v0/events/stream",
            handle: async ({ dependencies, request, response, url }) => {
                await streamEvents(
                    request,
                    response,
                    dependencies.agent.modules.events,
                    cursorFromRequest(request, url),
                    "durable",
                    dependencies.agent.agent.id,
                );
            },
        },
        {
            method: "POST",
            path: "/v0/events/trim",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, trimSchema);
                const result = await dependencies.agent.modules.events.trim(ctx, body.through);
                if (result === undefined) {
                    throw new AgentHttpError(409, "Event cursor is unavailable.", {
                        cursor: dependencies.agent.modules.events.cursor(),
                    });
                }
                sendJson(response, 200, result);
            },
        },
    ]);
}

function cursorFromRequest(request: IncomingMessage, url: URL): string | undefined {
    const value = request.headers["last-event-id"];
    const header = Array.isArray(value) ? value.at(-1) : value;
    const cursor = header ?? url.searchParams.get("after") ?? undefined;
    if (cursor !== undefined && !Value.Check(happyAgentEventIdSchema, cursor)) {
        throw new AgentHttpError(400, "The event cursor must be a UUIDv7 value.");
    }
    return cursor;
}

async function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    events: {
        readonly capacity: () => number;
        readonly cursor: () => string;
        readonly replay: (
            after?: string,
            limit?: number,
        ) =>
            | {
                  readonly cursor: string;
                  readonly events: readonly HappyAgentEvent[];
                  readonly latestCursor: string;
              }
            | undefined;
        readonly subscribe: (listener: (event: HappyAgentEvent) => void) => () => void;
    },
    after: string | undefined,
    mode: "durable" | "live",
    agentId: string,
): Promise<void> {
    const writer = createSseWriter(request, response);
    let replaying = true;
    let headersStarted = false;
    const pending: HappyAgentEvent[] = [];
    let pendingBytes = 0;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe = (): void => undefined;

    unsubscribe = events.subscribe((event) => {
        if (writer.closed) return;
        if (replaying) {
            const bytes = Buffer.byteLength(serializeJson(event), "utf8");
            if (pendingBytes + bytes > MAX_PENDING_BYTES) {
                writer.close();
                return;
            }
            pending.push(event);
            pendingBytes += bytes;
            return;
        }
        writer.write(sseEventFrame(event, mode));
    });

    const replay = events.replay(after, events.capacity());
    if (replay === undefined) {
        unsubscribe();
        writer.close();
        sendJson(response, 409, {
            cursor: events.cursor(),
            error: "Event cursor is unavailable.",
        });
        return;
    }
    if (writer.closed) {
        sendJson(response, 503, {
            error: "The event stream could not buffer its initial updates.",
        });
        return;
    }

    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    headersStarted = true;
    writer.write(": connected\n\n");
    writer.write(
        `event: hello\ndata: ${serializeJson({
            agentId,
            connectedAt: Date.now(),
            cursor: replay.latestCursor,
            protocolVersion: 0,
            resumed: after !== undefined,
        })}\n\n`,
    );
    const replayed = new Set<string>();
    for (const event of replay.events) {
        replayed.add(event.id);
        if (!writer.write(sseEventFrame(event, mode))) break;
    }
    replaying = false;
    for (const event of pending) {
        if (replayed.has(event.id)) continue;
        if (!writer.write(sseEventFrame(event, mode))) break;
    }
    pending.length = 0;
    pendingBytes = 0;
    heartbeat = setInterval(() => {
        writer.heartbeat(": keepalive\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();
    await writer.done;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe();
    if (headersStarted) {
        writer.close();
    }
}

function sseEventFrame(event: HappyAgentEvent, mode: "durable" | "live"): string {
    if (mode === "live") {
        return `id: ${event.id}\nevent: update\ndata: ${serializeJson({
            cursor: event.id,
            event,
        })}\n\n`;
    }
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${serializeJson(event)}\n\n`;
}

function groupModels(models: readonly { readonly providerId: string }[]): readonly unknown[] {
    return [...new Set(models.map((model) => model.providerId))].map((providerId) => ({
        models: models.filter((model) => model.providerId === providerId),
        providerId,
    }));
}
