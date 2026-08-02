import { request as requestHttp } from "node:http";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type {
    HappyNetworkEvent,
    HappyNetworkRequestCompletion,
    HappyNetworkRequestHandler,
    HappyNetworkSubscription,
    HappyNetworkTunnelHandler,
} from "./types.js";
import {
    HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES,
    happyNetworkEventSchema,
    happyNetworkRequestResultSchema,
    registerHappyNetworkListenerResponseSchema,
} from "./types.js";

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });

export interface HappyNetworkTransport {
    request<TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "PATCH" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>>;
    socketPath: string;
    token: string;
}

export async function startHappyNetworkRequestHandler(
    handler: HappyNetworkRequestHandler,
    transport: HappyNetworkTransport,
): Promise<HappyNetworkSubscription> {
    const registration = await transport.request(
        "POST",
        "/network/requests",
        registerHappyNetworkListenerResponseSchema,
        {},
    );
    const root = `/network/requests/${encodeURIComponent(registration.registrationId)}`;
    let closing = false;
    let stream: HappyNetworkEventStream;
    try {
        stream = await openEventStream({
            onEvent(event) {
                if (event.type !== "request") return;
                void Promise.resolve(
                    handler({
                        body: Buffer.from(event.bodyBase64, "base64"),
                        headers: event.headers,
                        hostname: event.hostname,
                        method: event.method,
                        mode: event.mode,
                        url: event.url,
                    }),
                )
                    .then((result) => {
                        if (event.mode !== "handle" || closing) return;
                        const decoded = Value.Decode(happyNetworkRequestResultSchema, result);
                        return transport.request(
                            "POST",
                            `${root}/calls/${encodeURIComponent(event.callId)}`,
                            emptyResponseSchema,
                            encodeCompletion(decoded),
                        );
                    })
                    .catch((error: unknown) => {
                        if (event.mode !== "handle" || closing) {
                            console.error(
                                `Happy network request observer failed: ${errorToMessage(error)}`,
                            );
                            return;
                        }
                        return transport
                            .request(
                                "POST",
                                `${root}/calls/${encodeURIComponent(event.callId)}`,
                                emptyResponseSchema,
                                { error: errorToMessage(error), type: "error" },
                            )
                            .catch(() => undefined);
                    });
            },
            path: `${root}/events`,
            socketPath: transport.socketPath,
            token: transport.token,
        });
    } catch (error) {
        await transport.request("DELETE", root, emptyResponseSchema).catch(() => undefined);
        throw error;
    }
    return subscription(stream, () => {
        closing = true;
    });
}

export async function startHappyNetworkTunnelHandler(
    handler: HappyNetworkTunnelHandler,
    transport: HappyNetworkTransport,
): Promise<HappyNetworkSubscription> {
    const registration = await transport.request(
        "POST",
        "/network/tunnels",
        registerHappyNetworkListenerResponseSchema,
        {},
    );
    const root = `/network/tunnels/${encodeURIComponent(registration.registrationId)}`;
    let stream: HappyNetworkEventStream;
    try {
        stream = await openEventStream({
            onEvent(event) {
                if (event.type === "tunnel") {
                    void Promise.resolve(handler(event)).catch((error: unknown) => {
                        console.error(
                            `Happy network tunnel observer failed: ${errorToMessage(error)}`,
                        );
                    });
                }
            },
            path: `${root}/events`,
            socketPath: transport.socketPath,
            token: transport.token,
        });
    } catch (error) {
        await transport.request("DELETE", root, emptyResponseSchema).catch(() => undefined);
        throw error;
    }
    return subscription(stream);
}

interface HappyNetworkEventStream {
    readonly closed: Promise<void>;
    close(): void;
}

function subscription(
    stream: HappyNetworkEventStream,
    onClose: () => void = () => undefined,
): HappyNetworkSubscription {
    let closeTask: Promise<void> | undefined;
    return {
        close() {
            closeTask ??= (async () => {
                onClose();
                stream.close();
                await stream.closed;
            })();
            return closeTask;
        },
    };
}

function encodeCompletion(
    result: Static<typeof happyNetworkRequestResultSchema>,
): HappyNetworkRequestCompletion {
    if (result.type === "pass_through") return result;
    const { body, ...rest } = result;
    return {
        ...rest,
        ...(body === undefined ? {} : { bodyBase64: Buffer.from(body).toString("base64") }),
    };
}

function openEventStream(options: {
    onEvent: (event: HappyNetworkEvent) => void;
    path: string;
    socketPath: string;
    token: string;
}): Promise<HappyNetworkEventStream> {
    return new Promise((resolve, reject) => {
        let opened = false;
        let settleClosed: () => void = () => undefined;
        const request = requestHttp(
            {
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
                            `Happy could not open the network event stream (HTTP ${String(response.statusCode ?? 500)}).`,
                        ),
                    );
                    return;
                }
                opened = true;
                let pending = "";
                let discardingOversizedLine = false;
                let settled = false;
                const closed = new Promise<void>((resolveClosed) => {
                    settleClosed = () => {
                        if (settled) return;
                        settled = true;
                        resolveClosed();
                    };
                });
                const stream = {
                    closed,
                    close() {
                        request.destroy();
                    },
                };
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    let remaining = chunk;
                    while (remaining.length > 0) {
                        if (discardingOversizedLine) {
                            const boundary = remaining.indexOf("\n");
                            if (boundary < 0) return;
                            remaining = remaining.slice(boundary + 1);
                            discardingOversizedLine = false;
                            continue;
                        }
                        const boundary = remaining.indexOf("\n");
                        if (boundary < 0) {
                            pending += remaining;
                            if (Buffer.byteLength(pending) > HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES) {
                                pending = "";
                                discardingOversizedLine = true;
                                console.error("Happy dropped an oversized network event.");
                            }
                            return;
                        }
                        const line = `${pending}${remaining.slice(0, boundary)}`;
                        pending = "";
                        remaining = remaining.slice(boundary + 1);
                        if (line.length === 0) continue;
                        if (Buffer.byteLength(line) > HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES) {
                            console.error("Happy dropped an oversized network event.");
                            continue;
                        }
                        try {
                            options.onEvent(
                                Value.Decode(happyNetworkEventSchema, JSON.parse(line)),
                            );
                        } catch (error) {
                            console.error(
                                `Happy dropped an invalid network event: ${errorToMessage(error)}`,
                            );
                        }
                    }
                });
                response.once("aborted", settleClosed);
                response.once("end", settleClosed);
                response.once("error", settleClosed);
                response.once("close", settleClosed);
                resolve(stream);
            },
        );
        request.once("error", (error) => {
            if (opened) settleClosed();
            else reject(error);
        });
        request.end();
    });
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
