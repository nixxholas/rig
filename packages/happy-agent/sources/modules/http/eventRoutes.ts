import type { IncomingMessage, ServerResponse } from "node:http";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { eventIdSchema, type AgentEvent } from "@slopus/happy-agent-modules";

import { readValidatedBody, parsePositiveLimit } from "./body.js";
import { AgentHttpError, sendJson, serializeJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { createRigModelCatalog, HAPPY_AGENT_RIG_PROTOCOL_VERSION } from "./rigProtocol.js";
import { readLiveRigPresence } from "./compatibilityRoutes.js";
import { sessionSummary } from "./sessionRoutes.js";
import { createSseWriter } from "./sseWriter.js";

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
            handle: async ({ ctx, dependencies, response }) => {
                const cursor = dependencies.agent.modules.events.cursor();
                const sessions = await dependencies.agent.modules.conversations.list(ctx, {
                    archived: false,
                    limit: 50,
                });
                sendJson(response, 200, {
                    catalog: createRigModelCatalog(dependencies.agent.system.models),
                    cursor,
                    folderItems: [],
                    folders: [],
                    identity: { version: dependencies.version ?? "0.0.0" },
                    presence: (await readLiveRigPresence(ctx, dependencies.agent)).presence,
                    projects: [],
                    protocolVersion: HAPPY_AGENT_RIG_PROTOCOL_VERSION,
                    sessions: await Promise.all(
                        sessions.map(
                            async (session) => await sessionSummary(ctx, dependencies, session),
                        ),
                    ),
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
                if (after !== undefined && !Value.Check(eventIdSchema, after)) {
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
    if (cursor !== undefined && !Value.Check(eventIdSchema, cursor)) {
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
                  readonly events: readonly AgentEvent[];
                  readonly latestCursor: string;
              }
            | undefined;
        readonly subscribe: (listener: (event: AgentEvent) => void) => () => void;
    },
    after: string | undefined,
    mode: "durable" | "live",
    agentId: string,
): Promise<void> {
    const writer = createSseWriter(request, response);
    let replaying = true;
    let headersStarted = false;
    const pending: AgentEvent[] = [];
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
        writeEvent(event);
    });

    const requestedReplay = events.replay(after, events.capacity());
    const gap = requestedReplay === undefined;
    const replay =
        requestedReplay ??
        (mode === "live"
            ? {
                  cursor: events.cursor(),
                  events: [] as readonly AgentEvent[],
                  latestCursor: events.cursor(),
              }
            : undefined);
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
            gap,
            protocolVersion: HAPPY_AGENT_RIG_PROTOCOL_VERSION,
            resumed: after !== undefined && !gap,
        })}\n\n`,
    );
    const replayed = new Set<string>();
    for (const event of replay.events) {
        replayed.add(event.id);
        if (!writeEvent(event)) break;
    }
    replaying = false;
    for (const event of pending) {
        if (replayed.has(event.id)) continue;
        if (!writeEvent(event)) break;
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

    function writeEvent(event: AgentEvent): boolean {
        if (mode === "durable") return writer.write(sseEventFrame(event));
        if (event.type === "session.created" && event.agentId !== undefined) {
            const payload =
                typeof event.payload === "object" && event.payload !== null
                    ? (event.payload as { readonly session?: unknown })
                    : undefined;
            const session =
                typeof payload?.session === "object" && payload.session !== null
                    ? (payload.session as { readonly id?: unknown })
                    : undefined;
            if (typeof session?.id !== "string") return true;
            const sessionValue = payload?.session;
            if (sessionValue === undefined) return true;
            return writer.write(
                `id: ${event.id}\nevent: update\ndata: ${serializeJson({
                    cursor: event.id,
                    event: {
                        createdAt: event.occurredAt,
                        data: { session: sessionValue },
                        id: event.id,
                        sessionId: session.id,
                        type: "session_current",
                        worktreeSupport: "unknown",
                    },
                })}\n\n`,
            );
        }
        return writer.write(
            `id: ${event.id}\nevent: update\ndata: ${serializeJson({
                cursor: event.id,
                event,
            })}\n\n`,
        );
    }
}

function sseEventFrame(event: AgentEvent): string {
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${serializeJson(event)}\n\n`;
}
