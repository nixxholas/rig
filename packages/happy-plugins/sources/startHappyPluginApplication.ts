import { request as requestHttp } from "node:http";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { TypeGuard } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

import type {
    HappyPluginApplication,
    HappyPluginApplicationAction,
    HappyPluginApplicationActionCompletion,
    HappyPluginApplicationEvent,
    HappyPluginApplicationStatus,
    HappyPluginApplicationResource,
    StartHappyPluginApplicationOptions,
} from "./types.js";
import {
    HAPPY_PLUGIN_MAX_APPLICATION_RESOURCE_BYTES,
    HAPPY_PLUGIN_MAX_RESOURCE_BYTES,
    happyPluginApplicationActionCompletionSchema,
    happyPluginApplicationEventSchema,
    happyPluginApplicationIdSchema,
    happyPluginApplicationRegistrationSchema,
    registerHappyPluginApplicationResponseSchema,
} from "./types.js";

const INITIAL_RECONNECT_DELAY_MS = 50;
const MAXIMUM_CONCURRENT_APPLICATION_ACTIONS = 64;
const MAXIMUM_EVENT_LINE_BYTES = 1024 * 1024 + 4096;
const MAXIMUM_RECONNECT_DELAY_MS = 1_000;

export interface HappyPluginApplicationTransport {
    request<TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "PATCH" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>>;
    socketPath: string;
    token: string;
}

interface ApplicationEventStream {
    readonly closed: Promise<Error>;
    close(): void;
}

interface ApplicationRegistration {
    readonly generation: string;
    readonly registrationId: string;
    stream?: ApplicationEventStream;
}

/** Defines one typed action callable only through the owning application's host bridge. */
export function defineHappyPluginApplicationAction<
    const TInputSchema extends TSchema,
    const TOutputSchema extends TSchema,
>(
    action: HappyPluginApplicationAction<TInputSchema, TOutputSchema>,
): HappyPluginApplicationAction<TInputSchema, TOutputSchema> {
    if (!TypeGuard.IsSchema(action.inputSchema) || !TypeGuard.IsSchema(action.outputSchema)) {
        throw new Error("A Happy plugin application action must use TypeBox schemas.");
    }
    Value.Assert(happyPluginApplicationIdSchema, action.name);
    return action;
}

/**
 * Registers one local application and keeps its action stream attached.
 *
 * A broken private socket stream is recovered with bounded backoff. Closing is terminal and waits
 * for any in-progress recovery so no registration can reappear after the plugin disposed it.
 */
export async function startHappyPluginApplication(
    options: StartHappyPluginApplicationOptions,
    transport: HappyPluginApplicationTransport,
): Promise<HappyPluginApplication> {
    const actions = new Map<string, HappyPluginApplicationAction>();
    for (const action of options.actions ?? []) {
        defineHappyPluginApplicationAction(action);
        if (actions.has(action.name)) {
            throw new Error(
                `The Happy plugin application has more than one action named "${action.name}".`,
            );
        }
        actions.set(action.name, action);
    }
    const registration = {
        actions: [...actions.keys()],
        entry: options.entry,
        id: options.id,
        navigation: options.navigation,
        resources: options.resources,
        title: options.title,
    };
    Value.Assert(happyPluginApplicationRegistrationSchema, registration);
    assertResources(registration.resources, registration.entry, registration.navigation.icon);

    const requests = new Map<string, AbortController>();
    const lifetime = new AbortController();
    let closing = false;
    let closeTask: Promise<void> | undefined;
    let current: ApplicationRegistration | undefined;
    let failure: string | undefined;
    let generation = "";
    let latestRegistrationId = "";
    let recovery: Promise<void> | undefined;
    let status: HappyPluginApplicationStatus = "reconnecting";

    const abortRequests = () => {
        for (const controller of requests.values()) controller.abort();
        requests.clear();
    };
    const unregister = (registrationId: string) =>
        transport
            .request(
                "DELETE",
                `/ui/applications/${encodeURIComponent(registrationId)}`,
                emptyResponseSchema,
            )
            .catch(() => undefined);
    const unregisterUnattached = async (candidate: ApplicationRegistration): Promise<void> => {
        if (current !== candidate || candidate.stream !== undefined) return;
        current = undefined;
        await unregister(candidate.registrationId);
    };

    const registerAndOpen = async (): Promise<void> => {
        const response = await transport.request(
            "POST",
            "/ui/applications",
            registerHappyPluginApplicationResponseSchema,
            registration,
        );
        const candidate: ApplicationRegistration = response;
        current = candidate;
        generation = candidate.generation;
        latestRegistrationId = candidate.registrationId;
        if (closing) {
            await unregisterUnattached(candidate);
            return;
        }
        let opened: ApplicationEventStream;
        try {
            opened = await openEventStream({
                onOpen(stream) {
                    candidate.stream = stream;
                },
                onEvent(event) {
                    if (closing || current !== candidate || candidate.stream === undefined) return;
                    if (event.type === "cancel") {
                        requests.get(event.requestId)?.abort();
                        return;
                    }
                    if (requests.size >= MAXIMUM_CONCURRENT_APPLICATION_ACTIONS) {
                        void transport
                            .request(
                                "POST",
                                `/ui/applications/${encodeURIComponent(candidate.registrationId)}/actions/${encodeURIComponent(event.requestId)}`,
                                emptyResponseSchema,
                                {
                                    error: `The application already has ${String(MAXIMUM_CONCURRENT_APPLICATION_ACTIONS)} actions in progress.`,
                                },
                            )
                            .catch(() => undefined);
                        return;
                    }
                    const controller = new AbortController();
                    requests.set(event.requestId, controller);
                    void executeAction(event, actions, controller.signal)
                        .then((completion) => {
                            if (
                                closing ||
                                current !== candidate ||
                                candidate.stream === undefined
                            ) {
                                return;
                            }
                            return transport.request(
                                "POST",
                                `/ui/applications/${encodeURIComponent(candidate.registrationId)}/actions/${encodeURIComponent(event.requestId)}`,
                                emptyResponseSchema,
                                completion,
                            );
                        })
                        .catch(() => undefined)
                        .finally(() => {
                            if (requests.get(event.requestId) === controller) {
                                requests.delete(event.requestId);
                            }
                        });
                },
                path: `/ui/applications/${encodeURIComponent(candidate.registrationId)}/events`,
                socketPath: transport.socketPath,
                token: transport.token,
            });
        } catch (error) {
            await unregisterUnattached(candidate);
            throw error;
        }
        if (closing) {
            if (current === candidate) current = undefined;
            opened.close();
            return;
        }

        failure = undefined;
        status = "connected";
        void opened.closed.then((error) => {
            if (closing || current !== candidate || candidate.stream !== opened) return;
            current = undefined;
            abortRequests();
            failure = error.message;
            status = "reconnecting";
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
        get generation() {
            return generation;
        },
        id: options.id,
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
            const candidate = current;
            current = undefined;
            const stream = candidate?.stream;
            stream?.close();
            abortRequests();
            const task = (async () => {
                if (stream !== undefined) {
                    await stream.closed;
                } else if (candidate !== undefined) {
                    await unregister(candidate.registrationId);
                }
                if (recoveryTask !== undefined) await recoveryTask;
            })();
            closeTask = task;
            return task;
        },
    };
}

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });

function assertResources(
    resources: readonly HappyPluginApplicationResource[],
    entry: string,
    icon: string | undefined,
): void {
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const resource of resources) {
        if (paths.has(resource.path)) {
            throw new Error(`The application has more than one resource at "${resource.path}".`);
        }
        paths.add(resource.path);
        const bytes = decodeResourceBody(resource);
        if (bytes.byteLength > HAPPY_PLUGIN_MAX_RESOURCE_BYTES) {
            throw new Error(
                `The application resource "${resource.path}" is larger than ${String(HAPPY_PLUGIN_MAX_RESOURCE_BYTES)} bytes.`,
            );
        }
        totalBytes += bytes.byteLength;
    }
    if (totalBytes > HAPPY_PLUGIN_MAX_APPLICATION_RESOURCE_BYTES) {
        throw new Error(
            `Application resources total more than ${String(HAPPY_PLUGIN_MAX_APPLICATION_RESOURCE_BYTES)} bytes.`,
        );
    }
    const entryResource = resources.find((resource) => resource.path === entry);
    if (entryResource?.mediaType !== "text/html") {
        throw new Error("The application entry must name one registered HTML resource.");
    }
    if (icon !== undefined && !paths.has(icon)) {
        throw new Error("The application navigation icon must name one registered resource.");
    }
}

function decodeResourceBody(resource: HappyPluginApplicationResource): Uint8Array {
    if (resource.encoding === "utf8") return Buffer.from(resource.body, "utf8");
    const bytes = Buffer.from(resource.body, "base64");
    const normalized = resource.body.replace(/=+$/u, "");
    if (bytes.toString("base64").replace(/=+$/u, "") !== normalized) {
        throw new Error(`The application resource "${resource.path}" is not valid base64.`);
    }
    return bytes;
}

async function executeAction(
    event: Extract<HappyPluginApplicationEvent, { type: "request" }>,
    actions: ReadonlyMap<string, HappyPluginApplicationAction>,
    signal: AbortSignal,
): Promise<HappyPluginApplicationActionCompletion> {
    const action = actions.get(event.action);
    if (action === undefined) {
        return { error: `The application no longer provides action "${event.action}".` };
    }
    try {
        const input = Value.Decode(action.inputSchema, event.input);
        const result = Value.Decode(action.outputSchema, await action.execute(input, { signal }));
        if (JSON.stringify(result) === undefined) {
            throw new Error("The application action result is not JSON serializable.");
        }
        return Value.Decode(happyPluginApplicationActionCompletionSchema, { result });
    } catch (error) {
        return { error: errorToMessage(error) };
    }
}

function openEventStream(options: {
    onOpen: (stream: ApplicationEventStream) => void;
    onEvent: (event: HappyPluginApplicationEvent) => void;
    path: string;
    socketPath: string;
    token: string;
}): Promise<ApplicationEventStream> {
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
                            `Happy could not open the application action stream (HTTP ${String(response.statusCode ?? 500)}).`,
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
                const stream: ApplicationEventStream = {
                    closed,
                    close() {
                        request.destroy();
                    },
                };
                options.onOpen(stream);
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    pending += chunk;
                    for (;;) {
                        const boundary = pending.indexOf("\n");
                        if (boundary < 0) break;
                        const line = pending.slice(0, boundary);
                        pending = pending.slice(boundary + 1);
                        if (line.length === 0) continue;
                        if (Buffer.byteLength(line) > MAXIMUM_EVENT_LINE_BYTES) {
                            request.destroy(
                                new Error("Happy sent an oversized application action event."),
                            );
                            return;
                        }
                        try {
                            options.onEvent(
                                Value.Decode(
                                    happyPluginApplicationEventSchema,
                                    JSON.parse(line) as unknown,
                                ),
                            );
                        } catch (error) {
                            request.destroy(
                                error instanceof Error ? error : new Error(String(error)),
                            );
                            return;
                        }
                    }
                    if (Buffer.byteLength(pending) > MAXIMUM_EVENT_LINE_BYTES) {
                        request.destroy(
                            new Error("Happy sent an oversized application action event."),
                        );
                    }
                });
                response.once("aborted", () =>
                    settleClosed(new Error("The Happy application action stream was interrupted.")),
                );
                response.once("end", () =>
                    settleClosed(
                        new Error("The Happy application action stream ended unexpectedly."),
                    ),
                );
                response.once("error", (error) => settleClosed(error));
                response.once("close", () =>
                    settleClosed(
                        new Error("The Happy application action stream closed unexpectedly."),
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

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("Application recovery stopped."));
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("Application recovery stopped."));
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
