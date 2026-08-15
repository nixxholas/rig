import type { IncomingMessage, ServerResponse } from "node:http";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { agentPermissionModeSchema, type AgentBaseMessageOptions } from "@slopus/happy-agent-base";
import { userInputAnswerSchema } from "@slopus/happy-agent-modules";
import type { SessionInputBlock, SessionUserMessage } from "@slopus/happy-providers";

import {
    conversationScopeSchema,
    conversationSessionIdSchema,
    type ConversationRecord,
    type ConversationScope,
} from "../conversations/ConversationModule.js";
import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import type { HappyAgentEvent } from "../events/EventsModule.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson, serializeJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { createSseWriter } from "./sseWriter.js";

const MAX_SESSION_STREAM_PENDING_BYTES = 1_024 * 1_024;

const textBlockSchema = Type.Object(
    { type: Type.Literal("text"), text: Type.String({ maxLength: 262_144 }) },
    { additionalProperties: false },
);
const imageBlockSchema = Type.Object(
    {
        data: Type.String({ maxLength: 16 * 1024 * 1024 }),
        mimeType: Type.String({ minLength: 1, maxLength: 256 }),
        type: Type.Literal("image"),
    },
    { additionalProperties: false },
);
const contentBlockSchema = Type.Union([textBlockSchema, imageBlockSchema]);

const submitMessageSchema = Type.Object(
    {
        await: Type.Optional(Type.Boolean()),
        clientSubmissionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        content: Type.Optional(Type.Array(contentBlockSchema, { maxItems: 256 })),
        displayText: Type.Optional(Type.String({ maxLength: 262_144 })),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        identity: Type.Optional(
            Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
        ),
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: Type.Optional(agentPermissionModeSchema),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Null()])),
        systemPrompt: Type.Optional(Type.Union([Type.String({ maxLength: 262_144 }), Type.Null()])),
        text: Type.String({ maxLength: 262_144 }),
    },
    { additionalProperties: false },
);

const createSessionSchema = Type.Object(
    {
        appendSystemPrompt: Type.Optional(Type.String({ maxLength: 262_144 })),
        cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        id: Type.Optional(conversationSessionIdSchema),
        identity: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        instructions: Type.Optional(Type.String({ maxLength: 262_144 })),
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: Type.Optional(agentPermissionModeSchema),
        projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        scope: Type.Optional(conversationScopeSchema),
        secretIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 256 }),
        ),
        serviceTier: Type.Optional(Type.Literal("fast")),
        trackUnread: Type.Optional(Type.Boolean()),
        workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        workflowsEnabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

const listSessionsSchema = Type.Object(
    {
        archived: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("all")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
);

const broadcastSchema = Type.Object(
    {
        all: Type.Optional(Type.Literal(true)),
        await: Type.Optional(Type.Boolean()),
        clientSubmissionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        content: Type.Optional(Type.Array(contentBlockSchema, { maxItems: 256 })),
        displayText: Type.Optional(Type.String({ maxLength: 262_144 })),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        identity: Type.Optional(
            Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
        ),
        modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: Type.Optional(agentPermissionModeSchema),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Null()])),
        sessionIds: Type.Optional(
            Type.Array(conversationSessionIdSchema, { minItems: 1, maxItems: 500 }),
        ),
        systemPrompt: Type.Optional(Type.Union([Type.String({ maxLength: 262_144 }), Type.Null()])),
        text: Type.String({ maxLength: 262_144 }),
    },
    { additionalProperties: false },
);

const scopeMutationSchema = Type.Object(
    {
        afterId: Type.Union([conversationSessionIdSchema, Type.Null()]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        scope: Type.Object({ kind: Type.Literal("unsorted") }, { additionalProperties: false }),
    },
    { additionalProperties: false },
);
const reorderSchema = Type.Object(
    { afterId: Type.Union([conversationSessionIdSchema, Type.Null()]) },
    { additionalProperties: false },
);
const draftSchema = Type.Object(
    {
        draft: Type.Union([Type.String({ maxLength: 100_000 }), Type.Null()]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        origin: Type.Optional(Type.String({ maxLength: 128 })),
        updatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
);
const patchSessionSchema = Type.Object(
    {
        appendSystemPrompt: Type.Union([Type.String({ maxLength: 262_144 }), Type.Null()]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
const modelSchema = Type.Object(
    {
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
const effortSchema = Type.Object(
    {
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
const tierSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(Type.Literal("fast")),
    },
    { additionalProperties: false },
);
const permissionsSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: agentPermissionModeSchema,
    },
    { additionalProperties: false },
);
const expectedRunSchema = Type.Object(
    {
        expectedRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        await: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
const goalSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        objective: Type.String({ minLength: 1, maxLength: 100_000 }),
    },
    { additionalProperties: false },
);
const goalStatusSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        status: Type.Union([
            Type.Literal("active"),
            Type.Literal("paused"),
            Type.Literal("blocked"),
            Type.Literal("complete"),
        ]),
    },
    { additionalProperties: false },
);
const secretSchema = Type.Object(
    {
        scope: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        secretId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);
const userInputSchema = Type.Object(
    {
        answer: Type.Optional(userInputAnswerSchema),
        cancel: Type.Optional(Type.Boolean()),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        reason: Type.Optional(Type.String({ maxLength: 4_096 })),
    },
    { additionalProperties: false },
);
const workflowStopSchema = Type.Object(
    { mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) },
    { additionalProperties: false },
);
const unsupportedSchema = Type.Object({}, { additionalProperties: false });

type SubmitMessage = Static<typeof submitMessageSchema>;
type CreateSession = Static<typeof createSessionSchema>;
const unknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type UnknownRecord = Static<typeof unknownRecordSchema>;
type LoadedSessionDependencies = {
    readonly agent: LoadedHappyAgent;
};

/**
 * Session/agent compatibility routes. Dynamic `:sessionId` paths are intentional route templates;
 * the daemon router resolves those templates before invoking this group.
 */
export function createSessionRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("sessions", [
        {
            method: "POST",
            path: "/v0/sessions",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, createSessionSchema);
                const conversation = dependencies.agent.modules.conversations;
                const existing =
                    body.id === undefined ? undefined : await conversation.get(ctx, body.id);
                if (existing !== undefined) {
                    sendJson(response, 201, {
                        session: await sessionResponse(ctx, dependencies, existing),
                    });
                    return;
                }
                const rootConfig =
                    (await dependencies.agent.system.config(ctx, dependencies.agent.agent.id)) ??
                    {};
                const agent = await dependencies.agent.system.create(ctx, rootConfig, {});
                const scope = body.scope ?? scopeFromCreate(body);
                const session = await conversation.ensure(ctx, {
                    agentId: agent.id,
                    cwd: body.cwd,
                    ...(body.id === undefined ? {} : { id: body.id }),
                    ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
                    ...(body.permissionMode === undefined
                        ? {}
                        : { permissionMode: body.permissionMode }),
                    ...(body.providerId === undefined ? {} : { providerId: body.providerId }),
                    scope,
                });
                await conversation.appendEvent(ctx, session.id, {
                    payload: { agentId: agent.id },
                    type: "session_created",
                });
                sendJson(response, 201, {
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions",
            handle: async ({ ctx, dependencies, url, response }) => {
                const parsed = parseListQuery(url);
                const sessions = await dependencies.agent.modules.conversations.list(ctx, parsed);
                sendJson(response, 200, {
                    sessions: await Promise.all(
                        sessions.map(
                            async (session) => await sessionSummary(ctx, dependencies, session),
                        ),
                    ),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/messages",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, broadcastSchema);
                const hasAll = body.all === true;
                const hasTargets = body.sessionIds !== undefined;
                if (hasAll === hasTargets) {
                    throw new AgentHttpError(
                        400,
                        "Broadcast messages require exactly one target selector.",
                    );
                }
                const sessions = hasAll
                    ? await dependencies.agent.modules.conversations.list(ctx, {
                          archived: false,
                          limit: 50,
                      })
                    : await Promise.all(
                          body.sessionIds!.map(
                              async (id) => await requireSession(ctx, dependencies, id),
                          ),
                      );
                const submissions = [];
                for (const session of sessions) {
                    const acceptance = await sendMessage(
                        ctx,
                        dependencies,
                        session,
                        body as SubmitMessage,
                    );
                    submissions.push(acceptance);
                }
                sendJson(response, 202, { submissions });
            },
        },
        ...createReadRoutes(),
        ...createMutationRoutes(),
    ]);
}

function createReadRoutes(): AgentHttpRouteGroup["routes"] {
    return [
        {
            method: "GET",
            path: "/v0/sessions/:sessionId",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, session, {
                        messageLimit: parseLimit(url.searchParams.get("message_limit"), 20, 50),
                    }),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/state",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const after = url.searchParams.get("after");
                const events = await dependencies.agent.modules.conversations.events(
                    ctx,
                    session.id,
                    after === null
                        ? { limit: parseLimit(url.searchParams.get("turns"), 20, 20) }
                        : { after, limit: parseLimit(url.searchParams.get("turns"), 20, 20) },
                );
                sendJson(response, 200, {
                    activity: activityFor(session),
                    append: url.searchParams.has("after"),
                    cursor: events.at(-1)?.id ?? dependencies.agent.modules.events.cursor(),
                    events,
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/transcript",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const page = await historyPage(ctx, dependencies, session.agentId, url);
                sendJson(response, 200, page);
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/usage",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                sendJson(
                    response,
                    200,
                    await dependencies.agent.modules.usage.read(ctx, session.agentId),
                );
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/current-provider-quota",
            handle: async ({ ctx, dependencies, url, response }) => {
                await requireSession(ctx, dependencies, sessionId(url));
                sendJson(response, 200, { currentProviderId: null, quota: null });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/subagents",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const page = await dependencies.agent.modules.collaboration.listAgents(
                    ctx,
                    session.agentId,
                    {},
                );
                sendJson(response, 200, { subagents: page.agents });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/events",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const journal = dependencies.agent.modules.events;
                const requestedAfter = url.searchParams.get("after");
                const replay = journal.replay(
                    requestedAfter ?? journal.originCursor(),
                    journal.capacity(),
                );
                if (replay === undefined) {
                    throw new AgentHttpError(409, "Event cursor not found.", {
                        cursor: journal.cursor(),
                    });
                }
                const limit = parseLimit(url.searchParams.get("message_limit"), 50, 100);
                const projected = replay.events
                    .filter((event) => event.agentId === session.agentId)
                    .flatMap((event) => {
                        const result = projectSessionEvent(event, session.id);
                        return result === undefined ? [] : [result];
                    });
                sendJson(response, 200, {
                    events:
                        requestedAfter === null
                            ? projected.slice(Math.max(0, projected.length - limit))
                            : projected.slice(0, limit),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/stream",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                await streamSessionEvents(request, response, dependencies, session, url);
            },
        },
    ];
}

function createMutationRoutes(): AgentHttpRouteGroup["routes"] {
    return [
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/messages",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, submitMessageSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                sendJson(response, 202, await sendMessage(ctx, dependencies, session, body));
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/steer",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, submitMessageSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                sendJson(response, 202, await steerMessage(ctx, dependencies, session, body));
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/abort",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, expectedRunSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                await dependencies.agent.system.abort(ctx, session.agentId, {
                    await: body.await ?? true,
                });
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        status: "aborted",
                    },
                );
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: {},
                        type: "abort_requested",
                    },
                );
                sendJson(response, 200, {
                    eventId: event.id,
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/compact",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, expectedRunSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                await dependencies.agent.system.compact(ctx, session.agentId, {
                    await: body.await ?? true,
                });
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: {},
                        type: "compaction_requested",
                    },
                );
                sendJson(response, 200, {
                    eventId: event.id,
                    result: "completed",
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/read",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        unread: false,
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/archive",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        archived: true,
                        status: "archived",
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/unarchive",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        archived: false,
                        status: "idle",
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/reorder",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, reorderSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: body,
                        type: "session_reordered",
                    },
                );
                sendJson(response, 200, {
                    eventId: event.id,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "PUT",
            path: "/v0/sessions/:sessionId/scope",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, scopeMutationSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        scope: body.scope,
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "PUT",
            path: "/v0/sessions/:sessionId/draft",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, draftSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const update = body.draft === null ? { draft: "" } : { draft: body.draft };
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    update,
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId",
            handle: async ({ request }) => {
                await readValidatedBody(request, patchSessionSchema);
                throw new AgentHttpError(503, "Prompt replacement is not owned by Agent Base.");
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId/model",
            handle: async ({ request }) => {
                await readValidatedBody(request, modelSchema);
                throw new AgentHttpError(409, "Model changes require a queued message.");
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId/effort",
            handle: async ({ request }) => {
                await readValidatedBody(request, effortSchema);
                throw new AgentHttpError(409, "Effort changes require a queued message.");
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId/service-tier",
            handle: async ({ request }) => {
                await readValidatedBody(request, tierSchema);
                throw new AgentHttpError(409, "Service-tier changes require a queued message.");
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId/permissions",
            handle: async ({ request }) => {
                await readValidatedBody(request, permissionsSchema);
                throw new AgentHttpError(409, "Permission changes require a queued message.");
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/goal",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, goalSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const goal = await dependencies.agent.modules.goal.setGoal(
                    ctx,
                    session.agentId,
                    body.objective,
                );
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: goal,
                        type: "goal_changed",
                    },
                );
                sendJson(response, 200, {
                    eventId: event.id,
                    goal,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId/goal",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, goalStatusSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const goal = await dependencies.agent.modules.goal.changeGoalStatus(
                    ctx,
                    session.agentId,
                    body.status,
                );
                sendJson(response, 200, {
                    goal,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "DELETE",
            path: "/v0/sessions/:sessionId/goal",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                await dependencies.agent.modules.goal.clearGoal(ctx, session.agentId);
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/secrets",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, secretSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const attachment = await dependencies.agent.modules.secrets.attach(
                    ctx,
                    session.agentId,
                    { scopeRef: body.scope ?? session.id, secretId: body.secretId },
                );
                sendJson(response, 200, {
                    attachment,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "DELETE",
            path: "/v0/sessions/:sessionId/secrets/:secretId",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const secretId = lastPathPart(url);
                await dependencies.agent.modules.secrets.detach(ctx, session.agentId, {
                    scopeRef: url.searchParams.get("scope") ?? session.id,
                    secretId,
                });
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/user-input/:requestId",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, userInputSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const requestId = lastPathPart(url);
                const result =
                    body.cancel === true
                        ? await dependencies.agent.modules.userInput.cancel(ctx, session.agentId, {
                              reason: body.reason ?? "Cancelled by client.",
                              requestId,
                          })
                        : body.answer === undefined
                          ? (() => {
                                throw new AgentHttpError(400, "An answer is required.");
                            })()
                          : await dependencies.agent.modules.userInput.answer(
                                ctx,
                                session.agentId,
                                { answer: body.answer, requestId },
                            );
                sendJson(response, 200, {
                    request: result,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/workflows/:runId/stop",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, workflowStopSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const result = await dependencies.agent.modules.workflows.cancel(
                    ctx,
                    session.agentId,
                    {
                        id: lastPathPart(url),
                        operationId: body.mutationId ?? `http-${Date.now()}`,
                    },
                );
                sendJson(response, 200, { workflow: result.run });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/scheduled-messages/:messageId/cancel",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                await readValidatedBody(request, workflowStopSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const result = await dependencies.agent.modules.scheduling.cancelSchedule(
                    ctx,
                    session.agentId,
                    {
                        scheduleId: lastPathPart(url),
                    },
                );
                sendJson(response, 200, { scheduledMessage: result });
            },
        },
        ...unsupportedMutations(),
    ];
}

function unsupportedMutations(): AgentHttpRouteGroup["routes"] {
    const paths = [
        "/v0/sessions/:sessionId/transfer",
        "/v0/sessions/:sessionId/fork",
        "/v0/sessions/:sessionId/reset",
        "/v0/sessions/:sessionId/rewind",
        "/v0/sessions/:sessionId/context",
        "/v0/sessions/:sessionId/activity",
    ] as const;
    return paths.map((path) => ({
        method: "POST" as const,
        path,
        handle: async ({ request }: { readonly request: IncomingMessage }) => {
            await readValidatedBody(request, unsupportedSchema);
            throw new AgentHttpError(503, "This session operation is not configured.");
        },
    }));
}

async function requireSession(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    id: string,
): Promise<ConversationRecord> {
    const session = await dependencies.agent.modules.conversations.get(ctx, id);
    if (session === undefined) throw new AgentHttpError(404, `Session "${id}" was not found.`);
    return session;
}

async function sessionResponse(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    options: { readonly messageLimit?: number } = {},
): Promise<Record<string, unknown>> {
    const agent = await dependencies.agent.system.resolve(ctx, session.agentId);
    const config = await dependencies.agent.system.config(ctx, session.agentId);
    const history =
        options.messageLimit === undefined
            ? undefined
            : await dependencies.agent.modules.history.read(ctx, session.agentId, {
                  from: "end",
                  limit: options.messageLimit,
              });
    return {
        ...sessionSummaryValue(session),
        activity: activityFor(session, agent.active),
        agentId: session.agentId,
        ...(config?.metadata === undefined ? {} : { metadata: config.metadata }),
        ...(history === undefined ? {} : { history }),
        snapshot: { active: agent.active, agentId: session.agentId },
    };
}

async function sessionSummary(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
): Promise<Record<string, unknown>> {
    const config = await dependencies.agent.system.config(ctx, session.agentId);
    return {
        ...sessionSummaryValue(session),
        ...(config?.metadata === undefined ? {} : { metadata: config.metadata }),
    };
}

function sessionSummaryValue(session: ConversationRecord): Record<string, unknown> {
    return {
        archived: session.archived,
        createdAt: session.createdAt,
        cwd: session.cwd,
        id: session.id,
        modelId: session.modelId,
        ownerInstanceId: session.ownerInstanceId,
        permissionMode: session.permissionMode,
        providerId: session.providerId,
        scope: session.scope,
        status: session.archived ? "archived" : session.status,
        titleStatus: session.titleStatus,
        unread: session.unread,
        updatedAt: session.updatedAt,
    };
}

function activityFor(
    session: ConversationRecord,
    active = session.status === "running" || session.status === "queued",
): Record<string, unknown> {
    return active
        ? { kind: "thinking", label: "Agent is working.", since: session.updatedAt }
        : {
              kind: session.status === "error" ? "error" : "idle",
              label: "Idle.",
              since: session.updatedAt,
          };
}

async function historyPage(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    agentId: string,
    url: URL,
): Promise<unknown> {
    const limit = parseLimit(url.searchParams.get("limit"), 20, 50);
    const after = url.searchParams.get("after");
    const cursor = after === null ? undefined : parseCursor(after);
    return await dependencies.agent.modules.history.read(ctx, agentId, {
        from: url.searchParams.has("before") ? "end" : "start",
        ...(cursor === undefined ? {} : { cursor }),
        limit,
    });
}

async function sendMessage(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    body: SubmitMessage,
): Promise<Record<string, unknown>> {
    const resumeCursor = dependencies.agent.modules.events.cursor();
    let acceptance;
    try {
        acceptance = await dependencies.agent.system.send(
            ctx,
            session.agentId,
            messageFromBody(body),
            messageOptions(body),
        );
    } catch (cause) {
        throw new Error("Agent Base rejected the session message.", { cause });
    }
    return {
        accepted: acceptance.accepted,
        delivery: acceptance.delivery,
        eventId:
            dependencies.agent.modules.events.messageCursor(session.agentId, acceptance.id) ??
            resumeCursor,
        id: acceptance.id,
        runId: acceptance.id,
        sessionId: session.id,
    };
}

async function steerMessage(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    body: SubmitMessage,
): Promise<Record<string, unknown>> {
    const resumeCursor = dependencies.agent.modules.events.cursor();
    const acceptance = await dependencies.agent.system.steer(
        ctx,
        session.agentId,
        messageFromBody(body),
        messageOptions(body),
    );
    return {
        accepted: acceptance.accepted,
        delivery: acceptance.delivery,
        eventId:
            dependencies.agent.modules.events.messageCursor(session.agentId, acceptance.id) ??
            resumeCursor,
        id: acceptance.id,
        runId: acceptance.id,
        sessionId: session.id,
    };
}

function messageFromBody(body: SubmitMessage): SessionUserMessage {
    const content: readonly SessionInputBlock[] =
        body.content === undefined || body.content.length === 0
            ? [{ text: body.text, type: "text" }]
            : body.content;
    return { content, role: "user" };
}

function messageOptions(
    body: SubmitMessage,
): AgentBaseMessageOptions & { readonly await?: boolean } {
    return {
        ...(body.await === undefined ? {} : { await: body.await }),
        ...(body.clientSubmissionId === undefined ? {} : { id: body.clientSubmissionId }),
        ...(body.effort === undefined ? {} : { effort: body.effort as never }),
        ...(body.modelId === undefined ? {} : { model: body.modelId }),
        ...(body.permissionMode === undefined ? {} : { permissionMode: body.permissionMode }),
        ...(body.providerId === undefined ? {} : { provider: body.providerId }),
        ...(body.serviceTier === undefined || body.serviceTier === null
            ? {}
            : { serviceTier: "priority" as never }),
    };
}

function parseListQuery(url: URL): { readonly archived?: boolean | "all"; readonly limit: number } {
    const raw = url.searchParams.get("archived");
    const archived =
        raw === null
            ? undefined
            : raw === "all"
              ? "all"
              : raw === "true"
                ? true
                : raw === "false"
                  ? false
                  : undefined;
    if (raw !== null && archived === undefined)
        throw new AgentHttpError(400, "The archived query is invalid.");
    const result = {
        ...(archived === undefined ? {} : { archived }),
        limit: parseLimit(url.searchParams.get("limit"), 50, 50),
    };
    if (!Value.Check(listSessionsSchema, result)) {
        throw new AgentHttpError(400, "The session list query is invalid.");
    }
    return result;
}

function parseLimit(value: string | null, fallback: number, maximum: number): number {
    if (value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new AgentHttpError(400, `The limit must be an integer from 1 to ${maximum}.`);
    }
    return parsed;
}

function parseCursor(value: string): number {
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new AgentHttpError(400, "The transcript cursor must be a non-negative integer.");
    }
    return cursor;
}

function scopeFromCreate(body: CreateSession): ConversationScope {
    if (body.workspaceId !== undefined && body.projectId !== undefined) {
        return { kind: "workspace", projectId: body.projectId, workspaceId: body.workspaceId };
    }
    if (body.projectId !== undefined) return { kind: "project", projectId: body.projectId };
    return { kind: "unsorted" };
}

function sessionId(url: URL): string {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    if (id === undefined || !Value.Check(conversationSessionIdSchema, id)) {
        throw new AgentHttpError(400, "The session ID is invalid.");
    }
    return id;
}

function lastPathPart(url: URL): string {
    const part = url.pathname.split("/").filter(Boolean).at(-1);
    if (part === undefined || part.length > 256)
        throw new AgentHttpError(400, "The path ID is invalid.");
    return part;
}

async function streamSessionEvents(
    request: IncomingMessage,
    response: ServerResponse,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    url: URL,
): Promise<void> {
    const events = dependencies.agent.modules.events;
    const header = request.headers["last-event-id"];
    const headerValue = Array.isArray(header) ? header.at(-1) : header;
    const after = headerValue ?? url.searchParams.get("after") ?? undefined;
    if (
        after !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(after)
    ) {
        throw new AgentHttpError(400, "The event cursor must be a UUIDv7 value.");
    }
    const writer = createSseWriter(request, response);
    let replaying = true;
    const pending: HappyAgentEvent[] = [];
    let pendingBytes = 0;
    const unsubscribe = events.subscribe((event: HappyAgentEvent) => {
        if (event.agentId !== session.agentId || writer.closed) return;
        if (replaying) {
            const bytes = Buffer.byteLength(serializeJson(event), "utf8");
            if (pendingBytes + bytes > MAX_SESSION_STREAM_PENDING_BYTES) {
                writer.close();
                return;
            }
            pending.push(event);
            pendingBytes += bytes;
            return;
        }
        writeEvent(event);
    });
    const replay = events.replay(after, events.capacity());
    if (replay === undefined) {
        unsubscribe();
        writer.close();
        throw new AgentHttpError(409, "Event cursor not found.");
    }
    if (writer.closed) {
        unsubscribe();
        throw new AgentHttpError(503, "The session stream could not buffer its initial updates.");
    }
    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    writer.write(
        `event: hello\ndata: ${serializeJson({
            cursor: replay.latestCursor,
            resumed: after !== undefined,
            sessionId: session.id,
        })}\n\n`,
    );
    const replayed = new Set<string>();
    for (const event of replay.events) {
        if (event.agentId !== session.agentId) continue;
        replayed.add(event.id);
        if (!writeEvent(event)) {
            unsubscribe();
            return;
        }
    }
    replaying = false;
    for (const event of pending) {
        if (replayed.has(event.id)) continue;
        if (!writeEvent(event)) {
            unsubscribe();
            return;
        }
    }
    pending.length = 0;
    pendingBytes = 0;
    const heartbeat = setInterval(() => {
        writer.heartbeat(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref();
    await writer.done;
    clearInterval(heartbeat);
    unsubscribe();

    function writeEvent(event: HappyAgentEvent): boolean {
        const projected = projectSessionEvent(event, session.id);
        if (projected === undefined) return true;
        return writer.write(
            `id: ${event.id}\nevent: ${projected.type}\ndata: ${serializeJson(projected)}\n\n`,
        );
    }
}

function projectSessionEvent(
    event: HappyAgentEvent,
    sessionIdValue: string,
): Record<string, unknown> | undefined {
    const payload = recordValue(event.payload);
    if (payload === undefined) return undefined;
    const base = {
        createdAt: event.occurredAt,
        id: event.id,
        sessionId: sessionIdValue,
    };
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    if (event.type === "message.accepted" && runId !== undefined) {
        const message = recordValue(payload.message);
        const blocks = message === undefined ? [] : providerInputBlocks(message.content);
        return {
            ...base,
            data: {
                delivery: payload.kind === "steering" ? "steer" : "run",
                displayText: blocks
                    .map((block) => (block.type === "text" ? block.text : "[image]"))
                    .join(""),
                message: { blocks, id: payload.id, role: "user" },
                runId,
            },
            type: "message_submitted",
        };
    }
    if (event.type === "provider.event" && runId !== undefined) {
        const providerEvent = recordValue(payload.event);
        const rigEvent = recordValue(payload.rigEvent);
        if (providerEvent === undefined) return undefined;
        if (rigEvent === undefined) {
            return {
                ...base,
                data: { event: providerEvent, runId },
                type: "provider_event",
            };
        }
        return {
            ...base,
            data: { event: rigEvent, providerEvent, runId },
            type: "agent_event",
        };
    }
    if ((event.type === "tool.started" || event.type === "tool.completed") && runId !== undefined) {
        const rigEvent = recordValue(payload.rigEvent);
        if (rigEvent === undefined) return undefined;
        return {
            ...base,
            data: { event: rigEvent, runId },
            type: "agent_event",
        };
    }
    if (event.type === "inference.completed" && runId !== undefined) {
        const inferenceId =
            typeof payload.inferenceId === "string" ? payload.inferenceId : `${runId}-inference`;
        return {
            ...base,
            data: {
                message: {
                    blocks: agentBlocks(payload.blocks),
                    id: inferenceId,
                    role: "agent",
                },
                runId,
            },
            type: "agent_message",
        };
    }
    if (event.type === "loop.settled" && runId !== undefined) {
        return {
            ...base,
            data: {
                modelLocked: false,
                runId,
                stopReason:
                    payload.stopReason === "aborted" ||
                    payload.stopReason === "error" ||
                    payload.stopReason === "length"
                        ? payload.stopReason
                        : "stop",
            },
            type: "run_finished",
        };
    }
    return undefined;
}

function agentBlocks(value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    const result: Record<string, unknown>[] = [];
    for (const entry of value) {
        const block = recordValue(entry);
        if (block?.type === "text" && typeof block.text === "string") {
            result.push({ text: block.text, type: "text" });
            continue;
        }
        if (block?.type === "thinking" && typeof block.thinking === "string") {
            result.push({
                thinking: block.thinking,
                type: "thinking",
                ...(typeof block.encrypted === "string" ? { encrypted: block.encrypted } : {}),
            });
            continue;
        }
        if (
            block?.type === "toolCall" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
        ) {
            result.push({
                arguments: block.arguments ?? {},
                id: block.id,
                name: block.name,
                ...(typeof block.namespace === "string" ? { namespace: block.namespace } : {}),
                ...(typeof block.providerToolCallId === "string"
                    ? { providerToolCallId: block.providerToolCallId }
                    : {}),
                type: "tool_call",
                ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
            });
            continue;
        }
        if (
            block?.type === "tool_result" &&
            typeof block.toolCallId === "string" &&
            typeof block.toolName === "string"
        ) {
            result.push({
                display: typeof block.display === "string" ? block.display : "",
                ...(block.isError === true ? { isError: true } : {}),
                rendered: Array.isArray(block.rendered) ? block.rendered : [],
                toolCallId: block.toolCallId,
                toolName: block.toolName,
                type: "tool_result",
            });
        }
    }
    return result;
}

function providerInputBlocks(value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    const result: Record<string, unknown>[] = [];
    for (const block of value) {
        const record = recordValue(block);
        if (record === undefined) return [];
        if (record.type === "text" && typeof record.text === "string") {
            result.push({ text: record.text, type: "text" });
            continue;
        }
        if (
            record.type === "image" &&
            typeof record.data === "string" &&
            typeof record.mimeType === "string"
        ) {
            result.push({ data: record.data, mediaType: record.mimeType, type: "image" });
        }
    }
    return result;
}

function recordValue(value: unknown): UnknownRecord | undefined {
    return Value.Check(unknownRecordSchema, value) ? value : undefined;
}
