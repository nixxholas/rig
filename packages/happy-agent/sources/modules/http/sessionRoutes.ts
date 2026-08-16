import type { IncomingMessage, ServerResponse } from "node:http";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentPermissionModeSchema,
    type AgentBaseMessageOptions,
    type AgentModel,
} from "@slopus/happy-agent-base";
import {
    eventIdSchema,
    userInputAnswerSchema,
    type AgentEvent,
    type UsageSummary,
} from "@slopus/happy-agent-modules";
import type { SessionInputBlock, SessionUserMessage } from "@slopus/happy-providers";

import {
    conversationScopeSchema,
    conversationSessionIdSchema,
    type ConversationRecord,
    type ConversationScope,
} from "../conversations/ConversationModule.js";
import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import type { EffectiveAgentSelection } from "../../vanillaHappyAgentConfiguration.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson, serializeJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { createRigModelCatalog, type RigModelCatalog } from "./rigProtocol.js";
import { createSseWriter } from "./sseWriter.js";
import {
    mergeAgentMessageOptions,
    resolveAgentMessageSelection,
    type AgentMessageOptionOverrides,
} from "./agentMessageOptions.js";

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
                if (body.workflowsEnabled === true) assertWorkflowsEnabled(dependencies.agent);
                resolveAgentMessageSelection(
                    dependencies.agent.effectiveSelection,
                    dependencies.agent.system.models,
                    {
                        ...(body.modelId === undefined ? {} : { model: body.modelId }),
                        ...(body.providerId === undefined ? {} : { provider: body.providerId }),
                        ...(body.effort === undefined ? {} : { effort: body.effort }),
                        ...(body.serviceTier === undefined
                            ? {}
                            : {
                                  serviceTier:
                                      body.serviceTier === null ? null : ("priority" as const),
                              }),
                    },
                );
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
                const summary = await sessionSummary(ctx, dependencies, session);
                await dependencies.agent.modules.events.record(ctx, {
                    agentId: agent.id,
                    payload: { session: summary },
                    type: "session.created",
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
                const after = url.searchParams.get("after") ?? undefined;
                const turnLimit = parseLimit(url.searchParams.get("turns"), 20, 20);
                sendJson(
                    response,
                    200,
                    await rigSessionState(ctx, dependencies, session, {
                        ...(after === undefined ? {} : { after }),
                        turnLimit,
                    }),
                );
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/transcript",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const after = url.searchParams.get("after") ?? undefined;
                const before = url.searchParams.get("before") ?? undefined;
                if (after !== undefined && before !== undefined) {
                    throw new AgentHttpError(
                        400,
                        "A transcript request cannot use both after and before.",
                    );
                }
                for (const cursor of [after, before]) {
                    if (cursor !== undefined && !Value.Check(eventIdSchema, cursor)) {
                        throw new AgentHttpError(400, "The transcript cursor must be a UUIDv7.");
                    }
                }
                sendJson(
                    response,
                    200,
                    await rigTranscript(dependencies, session, 20, {
                        ...(after === undefined ? {} : { after }),
                        ...(before === undefined ? {} : { before }),
                    }),
                );
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/usage",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const summary = await dependencies.agent.modules.usage.read(ctx, session.agentId);
                const catalog = createRigModelCatalog(dependencies.agent.system.models);
                sendJson(response, 200, protocolUsage(session, summary, catalog));
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/current-provider-quota",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const catalog = createRigModelCatalog(dependencies.agent.system.models);
                sendJson(response, 200, {
                    currentProviderId: session.providerId ?? catalog.defaultProviderId,
                });
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
                    { ownerAgentId: session.agentId },
                );
                const catalog = createRigModelCatalog(dependencies.agent.system.models);
                sendJson(response, 200, {
                    subagents: page.agents
                        .filter((agent) => agent.id !== session.agentId)
                        .map((agent) => ({
                            agentId: agent.id,
                            createdAt: agent.createdAt,
                            depth: agent.parentId === null ? 0 : 1,
                            description: agent.title ?? agent.role ?? "Collaborating agent",
                            id: agent.id,
                            modelId: catalog.defaultModelId,
                            parentSessionId: session.id,
                            status: agent.status === "active" ? "running" : "idle",
                            ...(agent.title === undefined ? {} : { taskName: agent.title }),
                            updatedAt: agent.updatedAt,
                        })),
                });
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
                assertWorkflowsEnabled(dependencies.agent);
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
    const transcript = await rigTranscript(dependencies, session, options.messageLimit ?? 20);
    const catalog = createRigModelCatalog(dependencies.agent.system.models);
    const tasks = await dependencies.agent.modules.tasks.list(ctx, session.agentId);
    const goal = await dependencies.agent.modules.goal.goal(ctx, session.agentId);
    const pendingUserInputs = (
        await dependencies.agent.modules.userInput.list(ctx, session.agentId, {
            status: "pending",
        })
    ).map((request) => ({
        ...(request.deadlineAt === undefined
            ? {}
            : {
                  autoResolutionMs: Math.max(0, request.deadlineAt - request.createdAt),
              }),
        questions: [
            {
                header: "Question",
                id: request.id,
                multiSelect: request.options?.multiSelect ?? false,
                options: request.options?.choices ?? [],
                question: request.question,
            },
        ],
        requestId: request.id,
    }));
    return {
        ...sessionSummaryValue(session, catalog, dependencies.agent.effectiveSelection),
        activity: activityFor(session, agent.active),
        agent: {
            depth: 0,
            rootSessionId: session.id,
            type: "primary",
        },
        agentId: session.agentId,
        environment: { type: "local" },
        goal,
        ...(config?.metadata === undefined ? {} : { metadata: config.metadata }),
        mcpServers: configuredMcpServers(),
        modelCatalog: catalog,
        modelLocked: false,
        models: catalog.models,
        pendingUserInputs,
        projectSecretIds: [],
        secretIds: [],
        sessionSecretIds: [],
        snapshot: { messages: transcript.messages },
        subagents: [],
        tasks,
        workflows: [],
        workflowsEnabled: dependencies.agent.configuration.values.features.workflows,
    };
}

function configuredMcpServers(): readonly {
    readonly name: string;
    readonly status: "blocked" | "disabled";
    readonly toolCount: 0;
}[] {
    return [];
}

function assertWorkflowsEnabled(agent: LoadedHappyAgent): void {
    if (!agent.configuration.values.features.workflows) {
        throw new AgentHttpError(503, "Workflows are disabled by configuration.");
    }
}

export async function sessionSummary(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
): Promise<Record<string, unknown>> {
    const config = await dependencies.agent.system.config(ctx, session.agentId);
    const catalog = createRigModelCatalog(dependencies.agent.system.models);
    return {
        ...sessionSummaryValue(session, catalog, dependencies.agent.effectiveSelection),
        ...(config?.metadata?.title === undefined ? {} : { title: config.metadata.title }),
        ...(dependencies.agent.modules.events.latestCursor(session.agentId) === undefined
            ? {}
            : { lastEventId: dependencies.agent.modules.events.latestCursor(session.agentId) }),
    };
}

function sessionSummaryValue(
    session: ConversationRecord,
    catalog = { defaultModelId: "", defaultProviderId: "" },
    defaults?: EffectiveAgentSelection,
): Record<string, unknown> {
    return {
        archived: session.archived,
        createdAt: session.createdAt,
        cwd: session.cwd,
        id: session.id,
        modelId: session.modelId ?? defaults?.model ?? catalog.defaultModelId,
        ownerInstanceId: session.ownerInstanceId,
        permissionMode: session.permissionMode ?? defaults?.permissionMode ?? "auto",
        providerId: session.providerId ?? defaults?.provider ?? catalog.defaultProviderId,
        scope: session.scope,
        status: session.archived ? "archived" : session.status,
        titleStatus: session.titleStatus === "ready" ? "ready" : "idle",
        ...(session.unread
            ? {
                  trackUnread: true,
                  unread: {
                      reason: "turn_finished",
                      since: session.updatedAt,
                  },
              }
            : {}),
        updatedAt: session.updatedAt,
    };
}

async function rigSessionState(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    options: { readonly after?: string; readonly turnLimit: number },
): Promise<Record<string, unknown>> {
    const transcript = await rigTranscript(
        dependencies,
        session,
        options.turnLimit,
        options.after === undefined ? {} : { after: options.after },
    );
    const protocolSession = await sessionResponse(ctx, dependencies, session, {
        messageLimit: options.turnLimit,
    });
    return {
        activity: activityFor(session),
        ...(options.after === undefined ? {} : { append: true }),
        cursor: dependencies.agent.modules.events.cursor(),
        ...(dependencies.agent.modules.events.latestCursor(session.agentId) === undefined
            ? {}
            : { lastEventId: dependencies.agent.modules.events.latestCursor(session.agentId) }),
        resumed: options.after !== undefined,
        session: {
            ...protocolSession,
            snapshot: { messages: transcript.messages },
        },
        transcript,
    };
}

async function rigTranscript(
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    turnLimit: number,
    cursor: { readonly after?: string; readonly before?: string } = {},
): Promise<Record<string, unknown>> {
    const journal = dependencies.agent.modules.events;
    const replay = journal.replay(journal.originCursor(), journal.capacity());
    if (replay === undefined) {
        throw new Error("The Happy Agent event journal could not build a transcript.");
    }
    const projected = replay.events
        .filter(
            (event) =>
                event.agentId === session.agentId &&
                (cursor.after === undefined || event.id > cursor.after) &&
                (cursor.before === undefined || event.id < cursor.before),
        )
        .flatMap((event) => {
            const value = projectSessionEvent(event, session.id);
            return value === undefined ? [] : [{ event, value }];
        });
    const messages: Record<string, unknown>[] = [];
    const messageCreatedAt: Record<string, number> = {};
    const messageEventId: Record<string, string> = {};
    const turns = new Map<
        string,
        {
            runId: string;
            startedAt: number;
            endedAt?: number;
            outcome?: "success" | "error" | "stopped";
            errorMessage?: string;
            messageIds: string[];
        }
    >();
    for (const { event, value } of projected) {
        const data = recordValue(value.data);
        const runId = typeof data?.runId === "string" ? data.runId : undefined;
        if (data === undefined || runId === undefined) continue;
        const turn = turns.get(runId) ?? {
            messageIds: [],
            runId,
            startedAt: event.occurredAt,
        };
        turn.startedAt = Math.min(turn.startedAt, event.occurredAt);
        if (value.type === "message_submitted" || value.type === "agent_message") {
            const message = recordValue(data.message);
            if (message !== undefined && typeof message.id === "string") {
                messages.push(message);
                turn.messageIds.push(message.id);
                messageCreatedAt[message.id] = event.occurredAt;
                messageEventId[message.id] = event.id;
            }
        }
        if (value.type === "run_finished") {
            turn.endedAt = event.occurredAt;
            const stopReason = data.stopReason;
            turn.outcome =
                stopReason === "error" ? "error" : stopReason === "aborted" ? "stopped" : "success";
            if (stopReason === "error" && typeof data.message === "string") {
                turn.errorMessage = data.message;
            }
        }
        turns.set(runId, turn);
    }
    const orderedTurns = [...turns.values()].sort(
        (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
    );
    const visibleTurns =
        cursor.after === undefined
            ? orderedTurns.slice(Math.max(0, orderedTurns.length - turnLimit))
            : orderedTurns.slice(0, turnLimit);
    const visibleMessageIds = new Set(visibleTurns.flatMap((turn) => turn.messageIds));
    const visibleMessages = messages.filter(
        (message) => typeof message.id === "string" && visibleMessageIds.has(message.id),
    );
    return {
        complete: visibleTurns.length === orderedTurns.length,
        messageCreatedAt: Object.fromEntries(
            Object.entries(messageCreatedAt).filter(([id]) => visibleMessageIds.has(id)),
        ),
        messageEventId: Object.fromEntries(
            Object.entries(messageEventId).filter(([id]) => visibleMessageIds.has(id)),
        ),
        messages: visibleMessages,
        turns: visibleTurns,
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

function protocolUsage(
    session: ConversationRecord,
    summary: UsageSummary,
    catalog: RigModelCatalog,
): Record<string, unknown> {
    const currentProviderId = session.providerId ?? catalog.defaultProviderId;
    const defaultModelId = session.modelId ?? catalog.defaultModelId;
    return {
        currentProviderId,
        groups: summary.groups.map((group) => {
            const modelId = group.model ?? defaultModelId;
            return {
                kind: "attributed",
                modelId,
                providerId: group.provider,
                requestedModelId: modelId,
                usage: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                        total: 0,
                    },
                    input: group.inputTokens,
                    output: group.outputTokens,
                    totalTokens: group.totalTokens,
                },
            };
        }),
        quotas: [],
        sessionTokenCount: {
            lastContextTokens: 0,
            totalTokens: summary.totalTokens,
        },
    };
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
            messageOptions(
                body,
                session,
                dependencies.agent.effectiveSelection,
                dependencies.agent.system.models,
            ),
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
        messageOptions(
            body,
            session,
            dependencies.agent.effectiveSelection,
            dependencies.agent.system.models,
        ),
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
    session: ConversationRecord,
    defaults: EffectiveAgentSelection,
    models: readonly AgentModel[],
): AgentBaseMessageOptions & { readonly await?: boolean } {
    return mergeAgentMessageOptions(defaults, models, {
        ...(body.await === undefined ? {} : { await: body.await }),
        ...(body.clientSubmissionId === undefined ? {} : { id: body.clientSubmissionId }),
        ...(body.effort === undefined ? {} : { effort: body.effort }),
        ...(body.modelId === undefined
            ? session.modelId === undefined
                ? {}
                : { model: session.modelId }
            : { model: body.modelId }),
        ...(body.permissionMode === undefined
            ? session.permissionMode === undefined
                ? {}
                : {
                      permissionMode: session.permissionMode as NonNullable<
                          AgentMessageOptionOverrides["permissionMode"]
                      >,
                  }
            : {
                  permissionMode: body.permissionMode as NonNullable<
                      AgentMessageOptionOverrides["permissionMode"]
                  >,
              }),
        ...(body.providerId === undefined
            ? session.providerId === undefined
                ? {}
                : { provider: session.providerId }
            : { provider: body.providerId }),
        ...(body.serviceTier === undefined
            ? {}
            : { serviceTier: body.serviceTier === null ? null : ("priority" as const) }),
    });
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
    const pending: AgentEvent[] = [];
    let pendingBytes = 0;
    const unsubscribe = events.subscribe((event: AgentEvent) => {
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

    function writeEvent(event: AgentEvent): boolean {
        const projected = projectSessionEvent(event, session.id);
        if (projected === undefined) return true;
        return writer.write(
            `id: ${event.id}\nevent: ${projected.type}\ndata: ${serializeJson(projected)}\n\n`,
        );
    }
}

export function projectSessionEvent(
    event: AgentEvent,
    sessionIdValue: string,
): Record<string, unknown> | undefined {
    const payload = recordValue(event.payload);
    if (payload === undefined) return undefined;
    const base = {
        createdAt: event.occurredAt,
        id: event.id,
        sessionId: sessionIdValue,
        worktreeSupport: "unknown",
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
