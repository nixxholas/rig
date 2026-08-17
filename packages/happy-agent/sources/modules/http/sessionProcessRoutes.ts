import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentPermissionModeSchema,
    withAgentConfig,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";
import type { HostCompute } from "@slopus/happy-agent-modules";
import { detach, type Context } from "@steve.kite/stdlib";

import {
    conversationSessionIdSchema,
    type ConversationRecord,
} from "../conversations/ConversationModule.js";
import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

const exact = { additionalProperties: false } as const;
const shellCommandRequestSchema = Type.Object(
    {
        command: Type.String({ maxLength: 262_144, minLength: 1, pattern: "\\S" }),
        commandId: Type.String({
            maxLength: 256,
            minLength: 1,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
    },
    exact,
);
const positiveIntegerStringSchema = Type.String({
    maxLength: 16,
    pattern: "^[1-9][0-9]*$",
});
const waitIntegerStringSchema = Type.String({
    maxLength: 8,
    pattern: "^[0-9]+$",
});
const processSessionIdSchema = Type.Integer({
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 1,
});
const waitMsSchema = Type.Integer({ maximum: 30_000, minimum: 0 });

type ShellCommandRequest = Static<typeof shellCommandRequestSchema>;

export function createSessionProcessRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("session-processes", [
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/shell",
            handle: async ({ ctx, dependencies, params, request, response }) => {
                const body = await readValidatedBody(request, shellCommandRequestSchema);
                const session = await requireSession(ctx, dependencies.agent, params.sessionId);
                const compute = await requireSessionCompute(ctx, dependencies.agent, session);
                await startShellCommand(ctx, dependencies.agent, session, compute, body, response);
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/background-processes/stop",
            handle: async ({ ctx, dependencies, params, response }) => {
                const session = await requireSession(ctx, dependencies.agent, params.sessionId);
                const compute = await requireSessionCompute(ctx, dependencies.agent, session);
                const stopAll = compute.shell.killAllSessions;
                if (stopAll === undefined) {
                    throw new AgentHttpError(
                        501,
                        "The Happy agent daemon does not support stopping all background processes yet.",
                    );
                }
                sendJson(response, 200, {
                    stoppedProcesses: await stopAll.call(compute.shell),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/background-processes/:processSessionId",
            handle: async ({ ctx, dependencies, params, response, url }) => {
                const session = await requireSession(ctx, dependencies.agent, params.sessionId);
                const compute = await requireSessionCompute(ctx, dependencies.agent, session);
                const processSessionId = parseProcessSessionId(params.processSessionId);
                const process = await compute.shell.readSession(processSessionId, {
                    peek: true,
                    waitMs: parseWaitMs(url.searchParams.get("waitMs")),
                });
                if (process === undefined) {
                    throw new AgentHttpError(404, "The background process was not found.");
                }
                sendJson(response, 200, process);
            },
        },
        {
            method: "DELETE",
            path: "/v0/sessions/:sessionId/background-processes/:processSessionId",
            handle: async ({ ctx, dependencies, params, response }) => {
                const session = await requireSession(ctx, dependencies.agent, params.sessionId);
                const compute = await requireSessionCompute(ctx, dependencies.agent, session);
                const process = await compute.shell.killSession(
                    parseProcessSessionId(params.processSessionId),
                );
                sendJson(
                    response,
                    200,
                    process === undefined ? { stopped: false } : { process, stopped: true },
                );
            },
        },
    ]);
}

async function startShellCommand(
    ctx: Context,
    agent: StartedHappyAgent,
    session: ConversationRecord,
    compute: HostCompute,
    body: ShellCommandRequest,
    response: import("node:http").ServerResponse,
): Promise<void> {
    const command = body.command.trim();
    let processSessionId: number;
    try {
        processSessionId = await compute.shell.startSession({
            command,
            maxOutputBytes: 512_000,
            permissions: computePermissions(permissionMode(agent, session)),
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "The shell command could not be started.";
        const result = {
            command,
            commandId: body.commandId,
            errorMessage: message,
            exitCode: null,
            output: message,
            timedOut: false,
        };
        const event = await agent.modules.conversations.appendEvent(ctx, session.id, {
            payload: result,
            type: "shell_command_finished",
        });
        sendJson(response, 200, { ...result, eventId: event.id, status: "finished" });
        return;
    }

    // This command came directly from the person, outside an agent turn. It must survive a turn
    // interruption while the TUI watches it through the background-process routes.
    compute.shell.detachSession?.(processSessionId);
    const event = await agent.modules.conversations.appendEvent(ctx, session.id, {
        payload: {
            command,
            commandId: body.commandId,
            sessionId: processSessionId,
        },
        type: "shell_command_started",
    });
    sendJson(response, 200, {
        command,
        commandId: body.commandId,
        eventId: event.id,
        sessionId: processSessionId,
        status: "running",
    });
}

async function requireSession(
    ctx: Context,
    agent: StartedHappyAgent,
    sessionId: string | undefined,
): Promise<ConversationRecord> {
    if (!Value.Check(conversationSessionIdSchema, sessionId)) {
        throw new AgentHttpError(400, "The session ID is invalid.");
    }
    const session = await agent.modules.conversations.get(ctx, sessionId);
    if (session === undefined) throw new AgentHttpError(404, "Session not found.");
    return session;
}

async function requireSessionCompute(
    ctx: Context,
    agent: StartedHappyAgent,
    session: ConversationRecord,
): Promise<HostCompute> {
    const config = await agent.system.config(ctx, session.agentId);
    if (config === undefined) throw new AgentHttpError(404, "Session agent not found.");
    // Compute owns processes beyond this request. Detaching prevents its process manager from
    // retaining the completed HTTP request lifetime when this is the first use of the compute.
    const compute = await agent.modules.compute.resolve(
        withAgentConfig(detach(ctx).named(`session-compute-${session.id}`), config),
        session.agentId,
    );
    if (compute === undefined) {
        throw new AgentHttpError(
            501,
            "The Happy agent daemon does not support shell commands for this session yet.",
        );
    }
    return compute;
}

function permissionMode(
    agent: StartedHappyAgent,
    session: ConversationRecord,
): AgentPermissionMode {
    const value = session.permissionMode ?? agent.configuration.values.defaults.permissionMode;
    if (!Value.Check(agentPermissionModeSchema, value)) {
        throw new Error("The session has an invalid permission mode.");
    }
    return value;
}

function parseProcessSessionId(value: string | undefined): number {
    if (!Value.Check(positiveIntegerStringSchema, value)) {
        throw new AgentHttpError(400, "The background process ID is invalid.");
    }
    const parsed = Number(value);
    if (!Value.Check(processSessionIdSchema, parsed)) {
        throw new AgentHttpError(400, "The background process ID is invalid.");
    }
    return parsed;
}

function parseWaitMs(value: string | null): number {
    if (value === null) return 0;
    if (!Value.Check(waitIntegerStringSchema, value)) {
        throw new AgentHttpError(400, "The background process wait must be an integer.");
    }
    const parsed = Number(value);
    if (!Value.Check(waitMsSchema, parsed)) {
        throw new AgentHttpError(
            400,
            "The background process wait must be between 0 and 30000 milliseconds.",
        );
    }
    return parsed;
}
