import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { createHappyPluginClient } from "./createHappyPluginClient.js";
import { normalizeHappyMcpName } from "./createHappyMcpToolName.js";
import { happyMcpCompletionToResult } from "./happyMcpCompletionToResult.js";
import type {
    HappyMcpServerRegistration,
    HappyMcpToolResult,
    HappyPluginClient,
    HappyPluginTestRequest,
    HappyPluginTestSeed,
    HappyProject,
    HappySession,
    HappyWorkspace,
} from "./types.js";
import {
    archiveWorkspaceBodySchema,
    createSessionInputSchema,
    createWorkspaceBodySchema,
    happyMcpCallCompletionSchema,
    happyMcpServerRegistrationSchema,
    happyPluginTestSeedSchema,
    listWorkspacesInputSchema,
    renameWorkspaceBodySchema,
    sendAgentMessageBodySchema,
} from "./types.js";

const CALL_TIMEOUT_MS = 10_000;
const MAXIMUM_BODY_BYTES = 1024 * 1024;

export interface HappyPluginTestHost {
    readonly client: HappyPluginClient;
    readonly environment: Readonly<{
        HAPPY_PLUGIN_DIRECTORY: string;
        HAPPY_PLUGIN_SOCKET_PATH: string;
        HAPPY_PLUGIN_TOKEN: string;
    }>;
    readonly mcp: {
        callTool(
            server: string,
            tool: string,
            argumentsValue?: unknown,
            options?: { signal?: AbortSignal; timeoutMs?: number },
        ): Promise<HappyMcpToolResult>;
        /** Simulates an unexpected daemon stream end for recovery tests. */
        disconnectServers(mode?: "close" | "end" | "error"): void;
        listTools(): readonly {
            description: string;
            inputSchema: unknown;
            server: string;
            tool: string;
        }[];
        waitForTools(count?: number, timeoutMs?: number): Promise<void>;
    };
    readonly requests: readonly HappyPluginTestRequest[];
    readonly rootDirectory: string;
    close(): Promise<void>;
}

export interface CreateHappyPluginTestHostOptions {
    /** Receives each validated SDK request as it reaches the fake host. */
    onRequest?: (request: HappyPluginTestRequest) => void;
    /** Parent for the short-lived host root. Defaults to the operating-system temp directory. */
    temporaryDirectory?: string;
}

interface TestRegistration {
    id: string;
    response?: ServerResponse;
    server: HappyMcpServerRegistration;
}

interface TestCall {
    cleanup(): void;
    reject(error: Error): void;
    resolve(result: HappyMcpToolResult): void;
}

/** Starts an in-memory, Unix-socket Happy host for plugin tests and local authoring. */
export async function createHappyPluginTestHost(
    seed: HappyPluginTestSeed = {},
    options: CreateHappyPluginTestHostOptions = {},
): Promise<HappyPluginTestHost> {
    Value.Assert(happyPluginTestSeedSchema, seed);
    // macOS caps Unix socket paths near 104 bytes. The OS temp root plus this deliberately short
    // generated name keeps the authenticated socket well below that limit without touching the
    // plugin's authored source folder.
    const root = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "hp-"));
    const socketPath = join(root, "h.sock");
    const pluginDirectory = join(root, "data");
    await mkdir(pluginDirectory, { mode: 0o700, recursive: true });
    const token = randomBytes(24).toString("base64url");
    const projects: HappyProject[] = structuredClone(seed.projects ?? []);
    const workspaces: HappyWorkspace[] = structuredClone(seed.workspaces ?? []);
    const sessions: HappySession[] = structuredClone(seed.sessions ?? []);
    const requests: HappyPluginTestRequest[] = [];
    const registrations = new Map<string, TestRegistration>();
    const calls = new Map<string, TestCall>();
    let nextId = 1;
    let closed = false;
    const toolWaiters = new Set<() => void>();
    const activeToolCount = () =>
        [...registrations.values()]
            .filter((registration) => registration.response !== undefined)
            .reduce((count, registration) => count + registration.server.tools.length, 0);

    const server = createServer((request, response) => {
        void (async () => {
            if (request.headers.authorization !== `Bearer ${token}`) {
                send(response, 401, { error: "This plugin connection is not authorized." });
                return;
            }
            const url = new URL(request.url ?? "/", "http://happy-plugin.test");
            const body =
                request.method === "GET" || request.method === "DELETE"
                    ? undefined
                    : await readBody(request);
            const observedRequest = {
                ...(body === undefined ? {} : { body: structuredClone(body) }),
                method: request.method ?? "GET",
                path: `${url.pathname}${url.search}`,
            };
            requests.push(observedRequest);
            options.onRequest?.(structuredClone(observedRequest));

            if (request.method === "GET" && url.pathname === "/projects") {
                send(response, 200, { projects });
                return;
            }
            if (request.method === "GET" && url.pathname === "/workspaces") {
                const input = Value.Decode(
                    listWorkspacesInputSchema,
                    url.searchParams.has("projectId")
                        ? { projectId: url.searchParams.get("projectId") }
                        : {},
                );
                send(response, 200, {
                    workspaces:
                        input.projectId === undefined
                            ? workspaces
                            : workspaces.filter(
                                  (workspace) => workspace.projectId === input.projectId,
                              ),
                });
                return;
            }
            if (request.method === "GET" && url.pathname === "/sessions") {
                send(response, 200, { sessions });
                return;
            }
            if (request.method === "POST" && url.pathname === "/sessions") {
                const input = Value.Decode(createSessionInputSchema, body);
                const session: HappySession = {
                    agentId: `test-agent-${String(nextId)}`,
                    archived: false,
                    cwd: input.cwd,
                    id: `test-session-${String(nextId++)}`,
                    projectId: projects[0]?.id ?? "test-project",
                    status: "idle",
                    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
                };
                sessions.push(session);
                send(response, 201, { session });
                return;
            }
            if (request.method === "POST" && url.pathname === "/mcp/servers") {
                const registeredServer = Value.Decode(happyMcpServerRegistrationSchema, body);
                if (
                    [...registrations.values()].some(
                        (registration) =>
                            normalizeHappyMcpName(registration.server.name).toLowerCase() ===
                            normalizeHappyMcpName(registeredServer.name).toLowerCase(),
                    )
                ) {
                    throw new Error(
                        `The fake Happy host already has an MCP server named "${registeredServer.name}".`,
                    );
                }
                const registration: TestRegistration = {
                    id: `test-registration-${String(nextId++)}`,
                    server: registeredServer,
                };
                registrations.set(registration.id, registration);
                send(response, 201, { registrationId: registration.id });
                return;
            }

            const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
            if (
                request.method === "GET" &&
                parts.length === 4 &&
                parts[0] === "mcp" &&
                parts[1] === "servers" &&
                parts[2] !== undefined &&
                parts[3] === "events"
            ) {
                const registration = registrations.get(parts[2]);
                if (registration === undefined) {
                    send(response, 404, { error: "That MCP registration is not active." });
                    return;
                }
                response.writeHead(200, {
                    "cache-control": "no-store",
                    "content-type": "application/x-ndjson",
                });
                response.flushHeaders();
                registration.response = response;
                response.once("close", () => {
                    if (registration.response === response) registrations.delete(registration.id);
                });
                for (const notify of toolWaiters) notify();
                toolWaiters.clear();
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 5 &&
                parts[0] === "mcp" &&
                parts[1] === "servers" &&
                parts[2] !== undefined &&
                parts[3] === "calls" &&
                parts[4] !== undefined
            ) {
                const call = calls.get(parts[4]);
                if (call === undefined) {
                    send(response, 409, { error: "That MCP call is no longer active." });
                    return;
                }
                calls.delete(parts[4]);
                const completion = Value.Decode(happyMcpCallCompletionSchema, body);
                call.resolve(happyMcpCompletionToResult(completion));
                send(response, 200, {});
                return;
            }
            if (
                request.method === "DELETE" &&
                parts.length === 3 &&
                parts[0] === "mcp" &&
                parts[1] === "servers" &&
                parts[2] !== undefined
            ) {
                registrations.get(parts[2])?.response?.end();
                registrations.delete(parts[2]);
                send(response, 200, {});
                return;
            }
            if (
                request.method === "POST" &&
                parts.length === 3 &&
                parts[0] === "agents" &&
                parts[1] !== undefined &&
                parts[2] === "messages"
            ) {
                Value.Decode(sendAgentMessageBodySchema, body);
                send(response, 202, {
                    delivered: true,
                    runId: `test-run-${String(nextId++)}`,
                    sessionId:
                        sessions.find((session) => session.agentId === parts[1])?.id ??
                        "test-session",
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
                    const input = Value.Decode(createWorkspaceBodySchema, body);
                    const workspace: HappyWorkspace = {
                        id: `test-workspace-${String(nextId++)}`,
                        name: input.name,
                        path: join(pluginDirectory, input.name),
                        projectId,
                        status: "ready",
                        version: 0,
                        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                    };
                    workspaces.push(workspace);
                    send(response, 201, { workspace });
                    return;
                }
                const workspace = workspaces.find(
                    (candidate) => candidate.projectId === projectId && candidate.id === parts[3],
                );
                if (workspace === undefined) {
                    send(response, 404, { error: "Workspace not found." });
                    return;
                }
                if (request.method === "PATCH" && parts.length === 4) {
                    const input = Value.Decode(renameWorkspaceBodySchema, body);
                    Object.assign(workspace, {
                        name: input.name,
                        version: workspace.version + 1,
                    });
                    send(response, 200, { workspace });
                    return;
                }
                if (request.method === "POST" && parts[4] === "archive") {
                    Value.Decode(archiveWorkspaceBodySchema, body);
                    Object.assign(workspace, {
                        archivedAt: Date.now(),
                        status: "archived",
                        version: workspace.version + 1,
                    });
                    send(response, 200, { workspace });
                    return;
                }
            }
            send(response, 404, { error: "This fake Happy host action does not exist." });
        })().catch((error: unknown) => {
            send(response, 400, { error: error instanceof Error ? error.message : String(error) });
        });
    });

    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });
    } catch (error) {
        await rm(root, { force: true, recursive: true });
        throw error;
    }

    const environment = {
        HAPPY_PLUGIN_DIRECTORY: pluginDirectory,
        HAPPY_PLUGIN_SOCKET_PATH: socketPath,
        HAPPY_PLUGIN_TOKEN: token,
    } as const;
    return {
        client: createHappyPluginClient({ socketPath, token }),
        environment,
        requests,
        rootDirectory: root,
        mcp: {
            async callTool(serverName, toolName, argumentsValue = {}, options = {}) {
                const registration = [...registrations.values()].find(
                    (candidate) =>
                        candidate.server.name === serverName && candidate.response !== undefined,
                );
                if (registration === undefined) {
                    throw new Error(`No active fake MCP server is named "${serverName}".`);
                }
                if (!registration.server.tools.some((tool) => tool.name === toolName)) {
                    throw new Error(
                        `The fake MCP server "${serverName}" has no tool named "${toolName}".`,
                    );
                }
                const callId = `test-call-${String(nextId++)}`;
                return new Promise<HappyMcpToolResult>((resolve, reject) => {
                    const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
                    let settled = false;
                    const cleanup = () => {
                        clearTimeout(timer);
                        options.signal?.removeEventListener("abort", abort);
                    };
                    const finishReject = (error: Error) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        reject(error);
                    };
                    const finishResolve = (result: HappyMcpToolResult) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve(result);
                    };
                    const timer = setTimeout(() => {
                        registration.response?.write(
                            `${JSON.stringify({ callId, type: "cancel" })}\n`,
                        );
                        calls.delete(callId);
                        finishReject(
                            new Error(`The fake MCP call timed out after ${String(timeoutMs)}ms.`),
                        );
                    }, timeoutMs);
                    timer.unref();
                    const abort = () => {
                        registration.response?.write(
                            `${JSON.stringify({ callId, type: "cancel" })}\n`,
                        );
                        calls.delete(callId);
                        finishReject(new Error("The fake MCP call was cancelled."));
                    };
                    calls.set(callId, {
                        cleanup,
                        reject: finishReject,
                        resolve: finishResolve,
                    });
                    if (options.signal?.aborted === true) {
                        abort();
                        return;
                    }
                    options.signal?.addEventListener("abort", abort, { once: true });
                    registration.response?.write(
                        `${JSON.stringify({
                            arguments: argumentsValue,
                            callId,
                            tool: toolName,
                            type: "call",
                        })}\n`,
                    );
                });
            },
            disconnectServers(mode = "end") {
                for (const registration of registrations.values()) {
                    if (mode === "error") {
                        registration.response?.destroy(
                            new Error("The fake Happy MCP stream disconnected."),
                        );
                    } else if (mode === "close") {
                        registration.response?.destroy();
                    } else {
                        registration.response?.end();
                    }
                }
            },
            listTools: () =>
                [...registrations.values()]
                    .filter((registration) => registration.response !== undefined)
                    .flatMap((registration) =>
                        registration.server.tools.map((tool) => ({
                            description: tool.description,
                            inputSchema: structuredClone(tool.inputSchema),
                            server: registration.server.name,
                            tool: tool.name,
                        })),
                    ),
            waitForTools(count = 1, timeoutMs = CALL_TIMEOUT_MS) {
                if (activeToolCount() >= count) {
                    return Promise.resolve();
                }
                return new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        toolWaiters.delete(notify);
                        reject(new Error("The fake host timed out waiting for MCP tools."));
                    }, timeoutMs);
                    timer.unref();
                    const notify = () => {
                        if (activeToolCount() < count) return;
                        clearTimeout(timer);
                        toolWaiters.delete(notify);
                        resolve();
                    };
                    toolWaiters.add(notify);
                });
            },
        },
        async close() {
            if (closed) return;
            closed = true;
            for (const call of calls.values()) {
                call.cleanup();
                call.reject(new Error("The fake Happy host closed."));
            }
            calls.clear();
            for (const registration of registrations.values()) registration.response?.end();
            registrations.clear();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
            await rm(root, { force: true, recursive: true });
        },
    };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAXIMUM_BODY_BYTES) throw new Error("The fake host request is too large.");
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text.length === 0 ? {} : (JSON.parse(text) as unknown);
}

function send(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent || response.destroyed) return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
    });
    response.end(body);
}
