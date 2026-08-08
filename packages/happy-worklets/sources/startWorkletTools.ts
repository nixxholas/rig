import { request as requestHttp } from "node:http";

import { type Static, type TSchema } from "@sinclair/typebox";
import { TypeGuard } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

import {
    emptyWorkletResponseSchema,
    registerWorkletToolsRequestSchema,
    registerWorkletToolsResponseSchema,
    workletEventSchema,
    workletToolResultSchema,
    type WorkletCallCompletion,
    type WorkletEvent,
    type WorkletToolDefinition,
} from "./types.js";

const MAXIMUM_EVENT_LINE_BYTES = 1024 * 1024;

export interface WorkletToolTransport {
    request<TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>>;
    socketPath: string;
    token: string;
}

/** Checks a tool at the point it is written, rather than when a model first calls it. */
export function defineWorkletTool<const TInputSchema extends TSchema>(
    tool: WorkletToolDefinition<TInputSchema>,
): WorkletToolDefinition<TInputSchema> {
    if (!TypeGuard.IsSchema(tool.inputSchema) || tool.inputSchema.type !== "object") {
        throw new Error("A worklet tool input schema must be a TypeBox object schema.");
    }
    Value.Assert(registerWorkletToolsRequestSchema.properties.tools.items, serializableTool(tool));
    return tool;
}

/**
 * Registers this worklet's tools with Rig and then answers calls on the NDJSON stream Rig opens
 * for them. Registration is complete only once the stream is attached, so a worklet that reports
 * ready has tools a model can actually reach.
 */
export async function startWorkletTools(
    tools: readonly WorkletToolDefinition[],
    transport: WorkletToolTransport,
): Promise<void> {
    const byName = new Map<string, WorkletToolDefinition>();
    for (const tool of tools) {
        defineWorkletTool(tool);
        if (byName.has(tool.name)) {
            throw new Error(`This worklet has more than one tool named "${tool.name}".`);
        }
        byName.set(tool.name, tool);
    }
    const registration = { tools: tools.map(serializableTool) };
    Value.Assert(registerWorkletToolsRequestSchema, registration);

    const response = await transport.request(
        "POST",
        "/tools",
        registerWorkletToolsResponseSchema,
        registration,
    );
    const registrationId = response.registrationId;
    const calls = new Map<string, AbortController>();

    await openEventStream({
        onEvent(event) {
            if (event.type === "cancel") {
                calls.get(event.callId)?.abort();
                return;
            }
            const controller = new AbortController();
            calls.set(event.callId, controller);
            void executeCall(event, byName, controller.signal)
                .then((completion) =>
                    transport.request(
                        "POST",
                        `/tools/${encodeURIComponent(registrationId)}/calls/${encodeURIComponent(event.callId)}`,
                        emptyWorkletResponseSchema,
                        completion,
                    ),
                )
                .catch(() => undefined)
                .finally(() => {
                    if (calls.get(event.callId) === controller) calls.delete(event.callId);
                });
        },
        path: `/tools/${encodeURIComponent(registrationId)}/events`,
        socketPath: transport.socketPath,
        token: transport.token,
    });
}

function serializableTool(tool: WorkletToolDefinition) {
    return {
        description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as unknown,
        name: tool.name,
    };
}

async function executeCall(
    event: Extract<WorkletEvent, { type: "call" }>,
    tools: ReadonlyMap<string, WorkletToolDefinition>,
    signal: AbortSignal,
): Promise<WorkletCallCompletion> {
    const tool = tools.get(event.tool);
    if (tool === undefined) {
        return { error: `This worklet no longer provides tool "${event.tool}".` };
    }
    try {
        const input = Value.Decode(tool.inputSchema, event.arguments);
        const result = await tool.execute(input, { signal });
        return { result: Value.Decode(workletToolResultSchema, result) };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function openEventStream(options: {
    onEvent: (event: WorkletEvent) => void;
    path: string;
    socketPath: string;
    token: string;
}): Promise<void> {
    return new Promise((resolve, reject) => {
        let opened = false;
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
                            `Happy could not open the worklet tool stream (HTTP ${String(response.statusCode ?? 500)}).`,
                        ),
                    );
                    return;
                }
                opened = true;
                let pending = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    pending += chunk;
                    if (Buffer.byteLength(pending) > MAXIMUM_EVENT_LINE_BYTES) {
                        request.destroy(new Error("Happy sent an oversized worklet tool event."));
                        return;
                    }
                    for (;;) {
                        const boundary = pending.indexOf("\n");
                        if (boundary < 0) break;
                        const line = pending.slice(0, boundary);
                        pending = pending.slice(boundary + 1);
                        if (line.length === 0) continue;
                        try {
                            options.onEvent(Value.Decode(workletEventSchema, JSON.parse(line)));
                        } catch (error) {
                            request.destroy(
                                error instanceof Error ? error : new Error(String(error)),
                            );
                        }
                    }
                });
                resolve();
            },
        );
        request.once("error", (error) => {
            if (!opened) reject(error);
        });
        request.end();
    });
}
