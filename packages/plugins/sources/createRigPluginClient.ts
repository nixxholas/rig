import { request as requestHttp } from "node:http";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { CreateRigPluginClientOptions, RigPluginClient } from "./types.js";
import {
    agentMessageDeliverySchema,
    archiveWorkspaceInputSchema,
    createRigPluginClientOptionsSchema,
    createSessionInputSchema,
    createWorkspaceInputSchema,
    listProjectsResponseSchema,
    listSessionsResponseSchema,
    listWorkspacesInputSchema,
    listWorkspacesResponseSchema,
    renameWorkspaceInputSchema,
    sendAgentMessageInputSchema,
    sessionResponseSchema,
    workspaceResponseSchema,
} from "./types.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const errorResponseSchema = Type.Object({ error: Type.String() }, { additionalProperties: true });
const requiredSettingSchema = Type.String({ minLength: 1, pattern: "\\S" });

/** An HTTP error returned by the owning Rig daemon for an otherwise valid SDK request. */
export class RigPluginApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "RigPluginApiError";
        this.status = status;
    }
}

/**
 * Creates a Rig extension API client.
 *
 * Normal extensions should use the exported `rig` singleton. Supplying a socket path and token is
 * useful for tests and custom harnesses.
 */
export function createRigPluginClient(options: CreateRigPluginClientOptions = {}): RigPluginClient {
    Value.Assert(createRigPluginClientOptionsSchema, options);
    const request = <TSchema_ extends TSchema>(
        method: "GET" | "PATCH" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>> =>
        requestJson({
            body,
            method,
            path,
            responseSchema,
            socketPath: requiredSetting(
                options.socketPath ?? process.env.RIG_PLUGIN_SOCKET_PATH,
                "RIG_PLUGIN_SOCKET_PATH",
            ),
            token: requiredSetting(
                options.token ?? process.env.RIG_PLUGIN_TOKEN,
                "RIG_PLUGIN_TOKEN",
            ),
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
    throw new Error(`Rig did not provide ${name} to this extension.`);
}

function requestJson<TSchema_ extends TSchema>(options: {
    body?: unknown;
    method: string;
    path: string;
    responseSchema: TSchema_;
    socketPath: string;
    token: string;
}): Promise<Static<TSchema_>> {
    return new Promise<Static<TSchema_>>((resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const request = requestHttp(
            {
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
                            new Error("Rig returned more extension data than the SDK can accept."),
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
                                : `Rig rejected the extension request with HTTP ${String(status)}.`;
                            reject(new RigPluginApiError(status, message));
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
