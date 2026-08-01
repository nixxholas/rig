import { request as requestHttp } from "node:http";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { TypeGuard } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

import type {
    HappyMcpCallCompletion,
    HappyMcpEvent,
    HappyMcpServer,
    HappyMcpServerStatus,
    HappyMcpTool,
    StartHappyMcpServerOptions,
} from "./types.js";
import {
    happyMcpEventSchema,
    happyMcpServerRegistrationSchema,
    happyMcpToolResultSchema,
    registerHappyMcpServerResponseSchema,
} from "./types.js";

const INITIAL_RECONNECT_DELAY_MS = 50;
const MAXIMUM_EVENT_LINE_BYTES = 1024 * 1024;
const MAXIMUM_RECONNECT_DELAY_MS = 1_000;

export interface HappyMcpTransport {
    request<TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "PATCH" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>>;
    socketPath: string;
    token: string;
}

interface HappyMcpEventStream {
    readonly closed: Promise<Error>;
    close(): void;
}

interface HappyMcpGeneration {
    readonly registrationId: string;
    stream?: HappyMcpEventStream;
}

export function defineMcpTool<const TInputSchema extends TSchema>(
    tool: HappyMcpTool<TInputSchema>,
): HappyMcpTool<TInputSchema> {
    if (!TypeGuard.IsSchema(tool.inputSchema) || tool.inputSchema.type !== "object") {
        throw new Error("A Happy MCP tool input schema must be a TypeBox object schema.");
    }
    Value.Assert(happyMcpServerRegistrationSchema.properties.tools.items, serializableTool(tool));
    return tool;
}

export async function startHappyMcpServer(
    options: StartHappyMcpServerOptions,
    transport: HappyMcpTransport,
): Promise<HappyMcpServer> {
    const tools = new Map<string, HappyMcpTool>();
    for (const tool of options.tools) {
        defineMcpTool(tool);
        if (tools.has(tool.name)) {
            throw new Error(`The Happy MCP server has more than one tool named "${tool.name}".`);
        }
        tools.set(tool.name, tool);
    }
    const registration = {
        name: options.name,
        tools: options.tools.map(serializableTool),
        ...(options.version === undefined ? {} : { version: options.version }),
    };
    Value.Assert(happyMcpServerRegistrationSchema, registration);

    const calls = new Map<string, AbortController>();
    const lifetime = new AbortController();
    let closing = false;
    let closeTask: Promise<void> | undefined;
    let currentGeneration: HappyMcpGeneration | undefined;
    let failure: string | undefined;
    let latestRegistrationId = "";
    let recovery: Promise<void> | undefined;
    let status: HappyMcpServerStatus = "reconnecting";

    const abortCalls = () => {
        for (const controller of calls.values()) controller.abort();
        calls.clear();
    };
    const unregister = (registrationId: string) =>
        transport
            .request(
                "DELETE",
                `/mcp/servers/${encodeURIComponent(registrationId)}`,
                emptyResponseSchema,
            )
            .catch(() => undefined);
    const unregisterUnattached = async (generation: HappyMcpGeneration): Promise<void> => {
        if (currentGeneration !== generation || generation.stream !== undefined) return;
        currentGeneration = undefined;
        await unregister(generation.registrationId);
    };

    const registerAndOpen = async (): Promise<void> => {
        const response = await transport.request(
            "POST",
            "/mcp/servers",
            registerHappyMcpServerResponseSchema,
            registration,
        );
        const registrationId = response.registrationId;
        const generation: HappyMcpGeneration = { registrationId };
        currentGeneration = generation;
        latestRegistrationId = registrationId;
        if (closing) {
            await unregisterUnattached(generation);
            return;
        }
        let opened: HappyMcpEventStream;
        try {
            opened = await openEventStream({
                onOpen(stream) {
                    generation.stream = stream;
                },
                onEvent(event) {
                    if (
                        closing ||
                        currentGeneration !== generation ||
                        generation.stream === undefined
                    ) {
                        return;
                    }
                    if (event.type === "cancel") {
                        calls.get(event.callId)?.abort();
                        return;
                    }
                    const controller = new AbortController();
                    calls.set(event.callId, controller);
                    void executeCall(event, tools, controller.signal)
                        .then((completion) => {
                            if (
                                closing ||
                                currentGeneration !== generation ||
                                generation.stream === undefined
                            ) {
                                return;
                            }
                            return transport.request(
                                "POST",
                                `/mcp/servers/${encodeURIComponent(registrationId)}/calls/${encodeURIComponent(event.callId)}`,
                                emptyResponseSchema,
                                completion,
                            );
                        })
                        .catch(() => undefined)
                        .finally(() => {
                            if (calls.get(event.callId) === controller) {
                                calls.delete(event.callId);
                            }
                        });
                },
                path: `/mcp/servers/${encodeURIComponent(registrationId)}/events`,
                socketPath: transport.socketPath,
                token: transport.token,
            });
        } catch (error) {
            await unregisterUnattached(generation);
            throw error;
        }
        if (closing) {
            if (currentGeneration === generation) currentGeneration = undefined;
            opened.close();
            return;
        }

        failure = undefined;
        status = "connected";
        void opened.closed.then((error) => {
            if (closing || currentGeneration !== generation || generation.stream !== opened) {
                return;
            }
            currentGeneration = undefined;
            abortCalls();
            failure = error.message;
            status = "reconnecting";
            // The host retires this registration when its stream closes. A DELETE here would race
            // socket teardown and target a generation the host has already retired.
            beginRecovery();
        });
    };

    const beginRecovery = () => {
        if (closing || recovery !== undefined) return;
        const task = (async () => {
            let delayMs = INITIAL_RECONNECT_DELAY_MS;
            while (!closing) {
                try {
                    await waitForReconnect(delayMs, lifetime.signal);
                    if (closing) return;
                    await registerAndOpen();
                    if (status === "connected" || closing) return;
                } catch (error) {
                    if (closing) return;
                    failure = errorToMessage(error);
                    status = "reconnecting";
                    delayMs = Math.min(delayMs * 2, MAXIMUM_RECONNECT_DELAY_MS);
                }
            }
        })().finally(() => {
            if (recovery === task) recovery = undefined;
        });
        recovery = task;
    };

    await registerAndOpen();

    return {
        get failure() {
            return failure;
        },
        name: options.name,
        get registrationId() {
            return latestRegistrationId;
        },
        get status() {
            return status;
        },
        close() {
            if (closeTask !== undefined) return closeTask;
            closing = true;
            status = "closed";
            lifetime.abort();
            const recoveryTask = recovery;
            const generation = currentGeneration;
            currentGeneration = undefined;
            const stream = generation?.stream;
            stream?.close();
            abortCalls();
            const task = (async () => {
                if (stream !== undefined) {
                    await stream.closed;
                } else if (generation !== undefined) {
                    await unregister(generation.registrationId);
                }
                if (recoveryTask !== undefined) await recoveryTask;
            })();
            closeTask = task;
            return task;
        },
    };
}

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });

function serializableTool(tool: HappyMcpTool) {
    const visibility = tool.visibility ?? ["model", "app"];
    return {
        _meta: { ui: { visibility } },
        description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as unknown,
        name: tool.name,
    };
}

async function executeCall(
    event: Extract<HappyMcpEvent, { type: "call" }>,
    tools: ReadonlyMap<string, HappyMcpTool>,
    signal: AbortSignal,
): Promise<HappyMcpCallCompletion> {
    const tool = tools.get(event.tool);
    if (tool === undefined) return { error: `The plugin no longer provides tool "${event.tool}".` };
    try {
        const input = Value.Decode(tool.inputSchema, event.arguments);
        const result = await tool.execute(input, { signal });
        return { result: Value.Decode(happyMcpToolResultSchema, result) };
    } catch (error) {
        return { error: errorToMessage(error) };
    }
}

function openEventStream(options: {
    onOpen: (stream: HappyMcpEventStream) => void;
    onEvent: (event: HappyMcpEvent) => void;
    path: string;
    socketPath: string;
    token: string;
}): Promise<HappyMcpEventStream> {
    return new Promise((resolve, reject) => {
        let opened = false;
        let settleClosed: (error: Error) => void = () => undefined;
        const request = requestHttp(
            {
                // Keep the stream independent from finite requests and daemon socket restarts.
                agent: false,
                headers: {
                    accept: "application/x-ndjson",
                    authorization: `Bearer ${options.token}`,
                },
                method: "GET",
                path: options.path,
                socketPath: options.socketPath,
            },
            (response) => {
                if ((response.statusCode ?? 500) !== 200) {
                    response.resume();
                    reject(
                        new Error(
                            `Happy could not open the MCP call stream (HTTP ${String(response.statusCode ?? 500)}).`,
                        ),
                    );
                    return;
                }
                opened = true;
                let pending = "";
                let settled = false;
                const closed = new Promise<Error>((resolveClosed) => {
                    settleClosed = (error) => {
                        if (settled) return;
                        settled = true;
                        resolveClosed(error);
                    };
                });
                const stream: HappyMcpEventStream = {
                    closed,
                    close() {
                        request.destroy();
                    },
                };
                options.onOpen(stream);
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    pending += chunk;
                    if (Buffer.byteLength(pending) > MAXIMUM_EVENT_LINE_BYTES) {
                        request.destroy(new Error("Happy sent an oversized MCP call event."));
                        return;
                    }
                    for (;;) {
                        const boundary = pending.indexOf("\n");
                        if (boundary < 0) break;
                        const line = pending.slice(0, boundary);
                        pending = pending.slice(boundary + 1);
                        if (line.length === 0) continue;
                        try {
                            options.onEvent(Value.Decode(happyMcpEventSchema, JSON.parse(line)));
                        } catch (error) {
                            request.destroy(
                                error instanceof Error ? error : new Error(String(error)),
                            );
                        }
                    }
                });
                response.once("aborted", () =>
                    settleClosed(new Error("The Happy MCP call stream was interrupted.")),
                );
                response.once("end", () =>
                    settleClosed(new Error("The Happy MCP call stream ended unexpectedly.")),
                );
                response.once("error", (error) => settleClosed(error));
                response.once("close", () =>
                    settleClosed(new Error("The Happy MCP call stream closed unexpectedly.")),
                );
                resolve(stream);
            },
        );
        request.once("error", (error) => {
            if (opened) settleClosed(error);
            else reject(error);
        });
        request.end();
    });
}

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("MCP recovery stopped."));
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("MCP recovery stopped."));
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
