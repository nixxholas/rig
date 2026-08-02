import { request as requestHttp } from "node:http";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { startHappyMcpServer } from "./startHappyMcpServer.js";
import type { CreateHappyPluginClientOptions, HappyPluginClient } from "./types.js";
import {
    agentMessageDeliverySchema,
    archiveWorkspaceInputSchema,
    createHappyPluginClientOptionsSchema,
    createSessionInputSchema,
    createWorkspaceInputSchema,
    executeWorkspaceCommandInputSchema,
    executeWorkspaceCommandResponseSchema,
    executeWorkspaceCommandResultSchema,
    listProjectsResponseSchema,
    listHappyProviderUsageResponseSchema,
    listPluginsResponseSchema,
    listSessionsResponseSchema,
    listWorkspacesInputSchema,
    listWorkspacesResponseSchema,
    readWorkspaceFileInputSchema,
    readWorkspaceFileResponseSchema,
    readWorkspaceFileResultSchema,
    renameWorkspaceInputSchema,
    sendAgentMessageInputSchema,
    sessionResponseSchema,
    workspaceResponseSchema,
    HAPPY_PLUGIN_MAX_FILE_BYTES,
    writeWorkspaceFileInputSchema,
    writeWorkspaceFileResultSchema,
} from "./types.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const errorResponseSchema = Type.Object({ error: Type.String() }, { additionalProperties: true });
const requiredSettingSchema = Type.String({ minLength: 1, pattern: "\\S" });

/** An HTTP error returned by the owning Happy daemon for an otherwise valid SDK request. */
export class HappyPluginApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "HappyPluginApiError";
        this.status = status;
    }
}

/**
 * Creates a Happy plugin API client.
 *
 * Normal plugins should use the exported `happy` singleton. Supplying a socket path and token is
 * useful for tests and custom harnesses.
 */
export function createHappyPluginClient(
    options: CreateHappyPluginClientOptions = {},
): HappyPluginClient {
    Value.Assert(createHappyPluginClientOptionsSchema, options);
    const socketPath = () =>
        requiredSetting(
            options.socketPath ?? process.env.HAPPY_PLUGIN_SOCKET_PATH,
            "HAPPY_PLUGIN_SOCKET_PATH",
        );
    const token = () =>
        requiredSetting(options.token ?? process.env.HAPPY_PLUGIN_TOKEN, "HAPPY_PLUGIN_TOKEN");
    const request = <TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "PATCH" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>> =>
        requestJson({
            body,
            method,
            path,
            responseSchema,
            socketPath: socketPath(),
            token: token(),
        });

    return {
        agents: {
            sendMessage: (input) => {
                Value.Assert(sendAgentMessageInputSchema, input);
                return request(
                    "POST",
                    `/agents/${encodeURIComponent(input.agentId)}/messages`,
                    agentMessageDeliverySchema,
                    { message: input.message },
                );
            },
        },
        projects: {
            list: async () =>
                (await request("GET", "/projects", listProjectsResponseSchema)).projects,
        },
        mcp: {
            startServer: (serverOptions) =>
                startHappyMcpServer(serverOptions, {
                    request,
                    get socketPath() {
                        return socketPath();
                    },
                    get token() {
                        return token();
                    },
                }),
        },
        plugins: {
            list: async () => (await request("GET", "/plugins", listPluginsResponseSchema)).plugins,
        },
        providers: {
            usage: async () =>
                (await request("GET", "/provider-usage", listHappyProviderUsageResponseSchema))
                    .providers,
        },
        sessions: {
            create: async (input) => {
                Value.Assert(createSessionInputSchema, input);
                return (await request("POST", "/sessions", sessionResponseSchema, input)).session;
            },
            list: async () =>
                (await request("GET", "/sessions", listSessionsResponseSchema)).sessions,
        },
        workspaces: {
            archive: async (input) => {
                Value.Assert(archiveWorkspaceInputSchema, input);
                return (
                    await request(
                        "POST",
                        `/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(input.workspaceId)}/archive`,
                        workspaceResponseSchema,
                        { version: input.version },
                    )
                ).workspace;
            },
            create: async (input) => {
                Value.Assert(createWorkspaceInputSchema, input);
                return (
                    await request(
                        "POST",
                        `/projects/${encodeURIComponent(input.projectId)}/workspaces`,
                        workspaceResponseSchema,
                        {
                            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                            name: input.name,
                        },
                    )
                ).workspace;
            },
            exec: async (input) => {
                Value.Assert(executeWorkspaceCommandInputSchema, input);
                const response = await request(
                    "POST",
                    `/workspaces/${encodeURIComponent(input.workspaceId)}/exec`,
                    executeWorkspaceCommandResponseSchema,
                    {
                        command: input.command,
                        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                    },
                );
                return Value.Decode(executeWorkspaceCommandResultSchema, {
                    exitCode: response.exitCode,
                    stderr: Buffer.from(response.stderrBase64, "base64").toString("utf8"),
                    stderrTruncated: response.stderrTruncated,
                    stdout: Buffer.from(response.stdoutBase64, "base64").toString("utf8"),
                    stdoutTruncated: response.stdoutTruncated,
                    timedOut: response.timedOut,
                });
            },
            files: {
                read: async (input) => {
                    Value.Assert(readWorkspaceFileInputSchema, input);
                    const response = await request(
                        "POST",
                        `/workspaces/${encodeURIComponent(input.workspaceId)}/files/read`,
                        readWorkspaceFileResponseSchema,
                        { path: input.path },
                    );
                    return Value.Decode(readWorkspaceFileResultSchema, {
                        bytes: response.bytes,
                        content: Buffer.from(response.contentBase64, "base64").toString("utf8"),
                    });
                },
                write: async (input) => {
                    Value.Assert(writeWorkspaceFileInputSchema, input);
                    const contentBytes = Buffer.byteLength(input.content, "utf8");
                    if (contentBytes > HAPPY_PLUGIN_MAX_FILE_BYTES) {
                        throw new Error(
                            `Workspace file content cannot exceed ${String(HAPPY_PLUGIN_MAX_FILE_BYTES)} UTF-8 bytes.`,
                        );
                    }
                    return request(
                        "POST",
                        `/workspaces/${encodeURIComponent(input.workspaceId)}/files/write`,
                        writeWorkspaceFileResultSchema,
                        {
                            contentBase64: Buffer.from(input.content, "utf8").toString("base64"),
                            path: input.path,
                        },
                    );
                },
            },
            list: async (input = {}) => {
                Value.Assert(listWorkspacesInputSchema, input);
                const query =
                    input.projectId === undefined
                        ? ""
                        : `?projectId=${encodeURIComponent(input.projectId)}`;
                return (await request("GET", `/workspaces${query}`, listWorkspacesResponseSchema))
                    .workspaces;
            },
            rename: async (input) => {
                Value.Assert(renameWorkspaceInputSchema, input);
                return (
                    await request(
                        "PATCH",
                        `/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(input.workspaceId)}`,
                        workspaceResponseSchema,
                        { name: input.name, version: input.version },
                    )
                ).workspace;
            },
        },
    };
}

function requiredSetting(value: string | undefined, name: string): string {
    if (Value.Check(requiredSettingSchema, value)) return value;
    throw new Error(`Happy did not provide ${name} to this plugin.`);
}

function requestJson<TSchema_ extends TSchema>(options: {
    body?: unknown;
    method: "DELETE" | "GET" | "PATCH" | "POST";
    path: string;
    responseSchema: TSchema_;
    socketPath: string;
    token: string;
}): Promise<Static<TSchema_>> {
    return new Promise<Static<TSchema_>>((resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const request = requestHttp(
            {
                // A plugin client has no Agent lifecycle to destroy, so never pool its sockets.
                agent: false,
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body).toString(),
                              "content-type": "application/json",
                          }),
                },
                method: options.method,
                path: options.path,
                socketPath: options.socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                let length = 0;
                response.on("data", (chunk: Buffer) => {
                    length += chunk.length;
                    if (length > MAX_RESPONSE_BYTES) {
                        request.destroy(
                            new Error("Happy returned more plugin data than the SDK can accept."),
                        );
                        return;
                    }
                    chunks.push(chunk);
                });
                response.once("end", () => {
                    try {
                        const text = Buffer.concat(chunks).toString("utf8");
                        const payload = text.length === 0 ? {} : (JSON.parse(text) as unknown);
                        const status = response.statusCode ?? 500;
                        if (status < 200 || status >= 300) {
                            const message = Value.Check(errorResponseSchema, payload)
                                ? payload.error
                                : `Happy rejected the plugin request with HTTP ${String(status)}.`;
                            reject(new HappyPluginApiError(status, message));
                            return;
                        }
                        resolve(Value.Decode(options.responseSchema, payload));
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        request.once("error", reject);
        request.end(body);
    });
}
