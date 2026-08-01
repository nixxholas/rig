import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentMessageDelivery, RigProject, RigSession, RigWorkspace } from "happy-plugins";
import {
    archiveWorkspaceBodySchema,
    createSessionInputSchema,
    createWorkspaceBodySchema,
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

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface CreateExtensionApiServerOptions {
    defaultDocker?: DockerExecutionConfig;
    extensionName: string;
    store: SessionStore;
    token: string;
}

export function createExtensionApiServer(options: CreateExtensionApiServerOptions): Server {
    return createServer((request, response) => {
        if (!isAuthorizedProtocolRequest(request, options.token)) {
            sendJson(response, 401, { error: "This extension connection is not authorized." });
            return;
        }
        void handleRequest(request, response, options).catch((error: unknown) => {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, error instanceof ExtensionApiRequestError ? 400 : 500, {
                error: errorToMessage(error),
            });
        });
    });
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: CreateExtensionApiServerOptions,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://rig-extension.local");
    if (request.method === "GET" && url.pathname === "/projects") {
        sendJson<{ projects: readonly RigProject[] }>(response, 200, {
            projects: options.store.listProjects().map(toRigProject),
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
        sendJson<{ workspaces: readonly RigWorkspace[] }>(response, 200, {
            workspaces: options.store.listWorkspaces(input.projectId).map(toRigWorkspace),
        });
        return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
        sendJson<{ sessions: readonly RigSession[] }>(response, 200, {
            sessions: options.store.list().map((session) => toRigSession(options.store, session)),
        });
        return;
    }
    if (request.method === "POST" && url.pathname === "/sessions") {
        const body = await readJson(request, createSessionInputSchema, "Session settings");
        const session = options.store.create(configureSessionRequest(body, options.defaultDocker));
        sendJson<{ session: RigSession }>(response, 201, {
            session: toRigSession(options.store, session.snapshot()),
        });
        return;
    }

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
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
            displayText: `${options.extensionName}: ${body.message}`,
            text: [
                `Message from the Rig extension ${JSON.stringify(options.extensionName)}.`,
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
            sendJson<{ workspace: RigWorkspace }>(response, 202, {
                workspace: toRigWorkspace(workspace),
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
            sendJson<{ workspace: RigWorkspace }>(response, 200, {
                workspace: toRigWorkspace(workspace),
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
            sendJson<{ workspace: RigWorkspace }>(response, 202, {
                workspace: toRigWorkspace(workspace),
            });
            return;
        }
    }

    sendJson(response, 404, { error: "This Rig extension API action does not exist." });
}

function toRigProject(project: Project): RigProject {
    return {
        ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
        id: project.id,
        name: project.name,
        path: project.path,
    };
}

function toRigWorkspace(workspace: ProjectWorkspace): RigWorkspace {
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

function toRigSession(
    store: SessionStore,
    session: Pick<
        SessionSummary,
        "archived" | "cwd" | "id" | "projectId" | "status" | "title" | "workspaceId"
    >,
): RigSession {
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
): Promise<Static<TSchema_>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > MAX_REQUEST_BYTES) {
            throw new ExtensionApiRequestError("The extension request is too large.");
        }
        chunks.push(bytes);
    }
    let value: unknown;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new ExtensionApiRequestError("The extension request is not valid JSON.");
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
        throw new ExtensionApiRequestError(`${subject} are invalid.${detail}`);
    }
}

class ExtensionApiRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExtensionApiRequestError";
    }
}
