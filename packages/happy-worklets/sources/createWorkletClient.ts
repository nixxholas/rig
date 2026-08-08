import { request as requestHttp } from "node:http";

import { type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { startWorkletTools } from "./startWorkletTools.js";
import {
    createWorkletClientOptionsSchema,
    emptyWorkletResponseSchema,
    type CreateWorkletClientOptions,
    type WorkletClient,
    type WorkletToolDefinition,
} from "./types.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** An HTTP error returned by the owning Happy daemon for an otherwise valid worklet request. */
export class WorkletApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "WorkletApiError";
        this.status = status;
    }
}

/**
 * Creates a worklet API client.
 *
 * Normal worklets should use the exported `worklet` singleton. Supplying a socket path and token
 * is useful for tests and custom harnesses.
 */
export function createWorkletClient(options: CreateWorkletClientOptions = {}): WorkletClient {
    Value.Assert(createWorkletClientOptionsSchema, options);
    const socketPath = () =>
        required(
            options.socketPath ?? process.env.HAPPY_WORKLET_SOCKET_PATH,
            "HAPPY_WORKLET_SOCKET_PATH",
        );
    const token = () =>
        required(options.token ?? process.env.HAPPY_WORKLET_TOKEN, "HAPPY_WORKLET_TOKEN");
    const request = <TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "POST",
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

    let registered = false;

    return {
        get data() {
            return required(
                process.env.HAPPY_WORKLET_DATA_DIRECTORY,
                "HAPPY_WORKLET_DATA_DIRECTORY",
            );
        },
        get name() {
            return required(process.env.HAPPY_WORKLET_NAME, "HAPPY_WORKLET_NAME");
        },
        async tools(tools: readonly WorkletToolDefinition[]) {
            if (registered) {
                throw new Error("A worklet declares its tools once, before it reports ready.");
            }
            registered = true;
            await startWorkletTools(tools, {
                request,
                socketPath: socketPath(),
                token: token(),
            });
        },
        async ready(status?: string) {
            await request(
                "POST",
                "/ready",
                emptyWorkletResponseSchema,
                status === undefined ? {} : { status },
            );
        },
        async status(status: string) {
            await request("POST", "/status", emptyWorkletResponseSchema, { status });
        },
    };
}

function required(value: string | undefined, name: string): string {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) {
        throw new Error(`Happy did not provide ${name}, so this worklet cannot reach Rig.`);
    }
    return trimmed;
}

export function requestJson<TSchema_ extends TSchema>(options: {
    body?: unknown;
    method: "DELETE" | "GET" | "POST";
    path: string;
    responseSchema: TSchema_;
    socketPath: string;
    token: string;
}): Promise<Static<TSchema_>> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
        const request = requestHttp(
            {
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                    ...(payload === undefined
                        ? {}
                        : {
                              "content-length": String(Buffer.byteLength(payload)),
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
                    length += chunk.byteLength;
                    if (length > MAX_RESPONSE_BYTES) {
                        request.destroy(new Error("Happy sent an oversized worklet response."));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.once("end", () => {
                    const status = response.statusCode ?? 500;
                    const text = Buffer.concat(chunks).toString("utf8");
                    if (status >= 400) {
                        reject(new WorkletApiError(status, readErrorMessage(text, status)));
                        return;
                    }
                    try {
                        resolve(
                            Value.Decode(
                                options.responseSchema,
                                text.length === 0 ? {} : JSON.parse(text),
                            ),
                        );
                    } catch (error) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                });
                response.once("error", reject);
            },
        );
        request.once("error", reject);
        if (payload !== undefined) request.write(payload);
        request.end();
    });
}

function readErrorMessage(text: string, status: number): string {
    try {
        const parsed: unknown = JSON.parse(text);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "error" in parsed &&
            typeof (parsed as { error: unknown }).error === "string"
        ) {
            return (parsed as { error: string }).error;
        }
    } catch {
        // The daemon answered with something other than JSON; the status is all we can report.
    }
    return `Happy rejected the worklet request (HTTP ${String(status)}).`;
}
