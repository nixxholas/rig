import { request as requestHttp } from "node:http";

import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const MAXIMUM_EVENT_LINE_BYTES = 1024 * 1024;

export interface HappyPluginEventStream {
    readonly closed: Promise<Error>;
    close(): void;
}

export function openHappyPluginEventStream<TEventSchema extends TSchema>(options: {
    eventSchema: TEventSchema;
    label: string;
    onEvent: (event: Static<TEventSchema>) => void | Promise<void>;
    path: string;
    socketPath: string;
    token: string;
}): Promise<HappyPluginEventStream> {
    return new Promise((resolve, reject) => {
        let opened = false;
        let settleClosed: (error: Error) => void = () => undefined;
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
                            `Happy could not open the ${options.label} stream (HTTP ${String(response.statusCode ?? 500)}).`,
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
                const stream: HappyPluginEventStream = {
                    closed,
                    close() {
                        request.destroy();
                    },
                };
                response.setEncoding("utf8");
                let waitingForHandler = false;
                const drainPending = () => {
                    if (waitingForHandler) return;
                    for (;;) {
                        const boundary = pending.indexOf("\n");
                        if (boundary < 0) return;
                        const line = pending.slice(0, boundary);
                        pending = pending.slice(boundary + 1);
                        if (line.length === 0) continue;
                        try {
                            const handled = options.onEvent(
                                Value.Decode(options.eventSchema, JSON.parse(line) as unknown),
                            );
                            if (handled instanceof Promise) {
                                waitingForHandler = true;
                                response.pause();
                                void handled
                                    .catch(() => undefined)
                                    .finally(() => {
                                        waitingForHandler = false;
                                        response.resume();
                                        drainPending();
                                    });
                                return;
                            }
                        } catch (error) {
                            request.destroy(
                                error instanceof Error ? error : new Error(String(error)),
                            );
                            return;
                        }
                    }
                };
                response.on("data", (chunk: string) => {
                    pending += chunk;
                    if (Buffer.byteLength(pending) > MAXIMUM_EVENT_LINE_BYTES) {
                        request.destroy(
                            new Error(`Happy sent an oversized ${options.label} event.`),
                        );
                        return;
                    }
                    drainPending();
                });
                response.once("aborted", () =>
                    settleClosed(new Error(`The Happy ${options.label} stream was interrupted.`)),
                );
                response.once("end", () =>
                    settleClosed(
                        new Error(`The Happy ${options.label} stream ended unexpectedly.`),
                    ),
                );
                response.once("error", settleClosed);
                response.once("close", () =>
                    settleClosed(
                        new Error(`The Happy ${options.label} stream closed unexpectedly.`),
                    ),
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
