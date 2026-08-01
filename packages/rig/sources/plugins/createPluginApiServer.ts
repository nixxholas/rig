import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
    AgentMessageDelivery,
    HappyProviderUsageEntry,
    HappyProject,
    HappySession,
    HappyWorkspace,
} from "happy-plugins";
import {
    archiveWorkspaceBodySchema,
    createSessionInputSchema,
    createWorkspaceBodySchema,
    happyMcpCallCompletionSchema,
    happyMcpServerRegistrationSchema,
    listWorkspacesInputSchema,
    renameWorkspaceBodySchema,
    sendAgentMessageBodySchema,
} from "happy-plugins";

import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import type { Project, ProjectWorkspace, SessionSummary } from "../protocol/index.js";
import { configureSessionRequest } from "../session/configureSessionRequest.js";
import type { SessionStore } from "../session/SessionStore.js";
import { isAuthorizedProtocolRequest } from "../server/isAuthorizedProtocolRequest.js";
import { sendJson } from "../server/sendJson.js";
import type { PluginMcpConnection } from "./PluginMcpRegistry.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface CreatePluginApiServerOptions {
    defaultDocker?: DockerExecutionConfig;
    listProviderUsage?: () => readonly HappyProviderUsageEntry[];
    mcp?: PluginMcpConnection;
    pluginName: string;
    store: SessionStore;
    token: string;
}

export function createPluginApiServer(options: CreatePluginApiServerOptions): Server {
    return createServer((request, response) => {
        if (!isAuthorizedProtocolRequest(request, options.token)) {
            sendJson(response, 401, { error: "This plugin connection is not authorized." });
            return;
        }
        void handleRequest(request, response, options).catch((error: unknown) => {
            if (isDatabaseFailure(error)) throw error;
            sendJson(
                response,
                error instanceof PluginApiRequestTooLargeError
                    ? 413
                    : error instanceof PluginApiRequestError
                      ? 400
                      : 500,
                {
                    error: errorToMessage(error),
                },
            );
        });
    });
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: CreatePluginApiServerOptions,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://rig-plugin.local");
    if (request.method === "GET" && url.pathname === "/projects") {
        sendJson<{ projects: readonly HappyProject[] }>(response, 200, {
            projects: options.store.listProjects().map(toHappyProject),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/workspaces") {
        const input = parseValue(
            listWorkspacesInputSchema,
            url.searchParams.has("projectId")
                ? { projectId: url.searchParams.get("projectId") ?? "" }
                : {},
            "Workspace list settings",
        );
        sendJson<{ workspaces: readonly HappyWorkspace[] }>(response, 200, {
            workspaces: options.store.listWorkspaces(input.projectId).map(toHappyWorkspace),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
        sendJson<{ sessions: readonly HappySession[] }>(response, 200, {
            sessions: options.store.list().map((session) => toHappySession(options.store, session)),
        });
        return;
    }
    if (request.method === "POST" && url.pathname === "/sessions") {
        const body = await readJson(request, createSessionInputSchema, "Session settings");
        const session = options.store.create(configureSessionRequest(body, options.defaultDocker));
        sendJson<{ session: HappySession }>(response, 201, {
            session: toHappySession(options.store, session.snapshot()),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/provider-usage") {
        sendJson<{ providers: readonly HappyProviderUsageEntry[] }>(response, 200, {
            providers: options.listProviderUsage?.() ?? [],
        });
        return;
    }

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "POST" && url.pathname === "/mcp/servers") {
        const mcp = requireMcp(options);
        const registration = await readJson(
            request,
            happyMcpServerRegistrationSchema,
            "MCP server registration",
        );
        sendJson(response, 201, { registrationId: mcp.register(registration) });
        return;
    }
    if (
        parts.length === 4 &&
        parts[0] === "mcp" &&
        parts[1] === "servers" &&
        parts[2] !== undefined &&
        parts[3] === "events" &&
        request.method === "GET"
    ) {
        const mcp = requireMcp(options);
        let detach = () => {};
        detach = mcp.attach(parts[2], (event) => {
            if (response.destroyed || response.writableEnded) return false;
            response.write(`${JSON.stringify(event)}\n`);
            return true;
        });
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        response.once("close", detach);
        return;
    }
    if (
        parts.length === 5 &&
        parts[0] === "mcp" &&
        parts[1] === "servers" &&
        parts[2] !== undefined &&
        parts[3] === "calls" &&
        parts[4] !== undefined &&
        request.method === "POST"
    ) {
        const mcp = requireMcp(options);
        let completion;
        try {
            completion = await readJson(request, happyMcpCallCompletionSchema, "MCP tool result");
        } catch (error) {
            // A malformed or oversized completion must settle the model call now. Leaving it
            // pending would turn a precise boundary error into an unrelated timeout.
            try {
                mcp.complete(parts[2], parts[4], {
                    error: `Rig rejected the plugin MCP result: ${errorToMessage(error)}`,
                });
            } catch {
                // The call may already have been cancelled or retired; preserve the request error.
            }
            throw error;
        }
        mcp.complete(parts[2], parts[4], completion);
        sendJson(response, 200, {});
        return;
    }
    if (
        parts.length === 3 &&
        parts[0] === "mcp" &&
        parts[1] === "servers" &&
        parts[2] !== undefined &&
        request.method === "DELETE"
    ) {
        requireMcp(options).unregister(parts[2]);
        sendJson(response, 200, {});
        return;
    }
    if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "agents" &&
        parts[1] !== undefined &&
        parts[2] === "messages"
    ) {
        const body = await readJson(request, sendAgentMessageBodySchema, "Agent message");
        const target = options.store.findByAgentId(parts[1]);
        if (target === undefined) {
            sendJson(response, 404, { error: "No agent has that Agent ID." });
            return;
        }
        const delivered = target.deliverNotification({
            displayText: `${options.pluginName}: ${body.message}`,
            text: [
                `Message from the Rig plugin ${JSON.stringify(options.pluginName)}.`,
                "",
                body.message,
            ].join("\n"),
        });
        sendJson<AgentMessageDelivery>(response, 202, {
            delivered: true,
            runId: delivered.runId,
            sessionId: delivered.sessionId,
        });
        return;
    }

    if (
        parts.length >= 3 &&
        parts[0] === "projects" &&
        parts[1] !== undefined &&
        parts[2] === "workspaces"
    ) {
        const projectId = parts[1];
        if (request.method === "POST" && parts.length === 3) {
            const body = await readJson(request, createWorkspaceBodySchema, "Workspace settings");
            const workspace = await options.store.createWorkspace(projectId, {
                ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                name: body.name,
            });
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Project not found." });
                return;
            }
            sendJson<{ workspace: HappyWorkspace }>(response, 202, {
                workspace: toHappyWorkspace(workspace),
            });
            return;
        }
        const workspaceId = parts[3];
        if (workspaceId !== undefined && request.method === "PATCH" && parts.length === 4) {
            const body = await readJson(
                request,
                renameWorkspaceBodySchema,
                "Workspace rename settings",
            );
            const workspace = options.store.renameWorkspace(
                projectId,
                workspaceId,
                body.name,
                body.version,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found." });
                return;
            }
            sendJson<{ workspace: HappyWorkspace }>(response, 200, {
                workspace: toHappyWorkspace(workspace),
            });
            return;
        }
        if (
            workspaceId !== undefined &&
            request.method === "POST" &&
            parts.length === 5 &&
            parts[4] === "archive"
        ) {
            const body = await readJson(
                request,
                archiveWorkspaceBodySchema,
                "Workspace archive settings",
            );
            const workspace = await options.store.archiveWorkspace(
                projectId,
                workspaceId,
                body.version,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found." });
                return;
            }
            sendJson<{ workspace: HappyWorkspace }>(response, 202, {
                workspace: toHappyWorkspace(workspace),
            });
            return;
        }
    }

    sendJson(response, 404, { error: "This Rig plugin API action does not exist." });
}

function toHappyProject(project: Project): HappyProject {
    return {
        ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
        id: project.id,
        name: project.name,
        path: project.path,
    };
}

function toHappyWorkspace(workspace: ProjectWorkspace): HappyWorkspace {
    return {
        ...(workspace.archivedAt === undefined ? {} : { archivedAt: workspace.archivedAt }),
        ...(workspace.baseRef === undefined ? {} : { baseRef: workspace.baseRef }),
        ...(workspace.error === undefined ? {} : { error: workspace.error }),
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        projectId: workspace.projectId,
        status: workspace.status,
        version: workspace.version,
    };
}

function toHappySession(
    store: SessionStore,
    session: Pick<
        SessionSummary,
        "archived" | "cwd" | "id" | "projectId" | "status" | "title" | "workspaceId"
    >,
): HappySession {
    const agentId = store.get(session.id)?.agentIdentity().agentId;
    if (agentId === undefined) {
        throw new Error(`Rig could not resolve the agent for session ${session.id}.`);
    }
    return {
        agentId,
        archived: session.archived,
        cwd: session.cwd,
        id: session.id,
        projectId: session.projectId,
        status: session.status,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    };
}

async function readJson<TSchema_ extends TSchema>(
    request: IncomingMessage,
    schema: TSchema_,
    subject: string,
    maximumBytes = MAX_REQUEST_BYTES,
): Promise<Static<TSchema_>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maximumBytes) {
            throw new PluginApiRequestTooLargeError("The plugin request is too large.");
        }
        chunks.push(bytes);
    }
    let value: unknown;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new PluginApiRequestError("The plugin request is not valid JSON.");
    }
    return parseValue(schema, value, subject);
}

function parseValue<TSchema_ extends TSchema>(
    schema: TSchema_,
    value: unknown,
    subject: string,
): Static<TSchema_> {
    try {
        return Value.Decode(schema, value);
    } catch {
        const first = Value.Errors(schema, value).First();
        const detail = first === undefined ? "" : ` ${first.path || "value"}: ${first.message}`;
        throw new PluginApiRequestError(`${subject} are invalid.${detail}`);
    }
}

class PluginApiRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginApiRequestError";
    }
}

class PluginApiRequestTooLargeError extends PluginApiRequestError {
    constructor(message: string) {
        super(message);
        this.name = "PluginApiRequestTooLargeError";
    }
}

function requireMcp(options: CreatePluginApiServerOptions): PluginMcpConnection {
    if (options.mcp === undefined) {
        throw new PluginApiRequestError("This plugin runtime does not provide MCP registration.");
    }
    return options.mcp;
}
