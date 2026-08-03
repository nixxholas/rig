import { type Static, type TSchema, Type } from "@sinclair/typebox";

import type { HappyMcpTransport } from "./startHappyMcpServer.js";
import {
    openHappyPluginEventStream,
    type HappyPluginEventStream,
} from "./openHappyPluginEventStream.js";
import { registerHappyPluginStreamResponseSchema, type HappyPluginStreamStatus } from "./types.js";

const INITIAL_RECONNECT_DELAY_MS = 50;
const MAXIMUM_RECONNECT_DELAY_MS = 1_000;

export interface HappyPluginEventRegistration {
    readonly failure: string | undefined;
    readonly registrationId: string;
    readonly status: HappyPluginStreamStatus;
    close(): Promise<void>;
}

interface RegistrationGeneration {
    readonly registrationId: string;
    stream?: HappyPluginEventStream;
}

export async function startHappyPluginEventRegistration<TEventSchema extends TSchema>(options: {
    deletePath: (registrationId: string) => string;
    eventPath: (registrationId: string) => string;
    eventSchema: TEventSchema;
    label: string;
    onEvent: (event: Static<TEventSchema>, registrationId: string) => void | Promise<void>;
    onGenerationClosed?: (registrationId: string) => void;
    registerBody?: unknown;
    registerPath: string;
    recover?: boolean;
    transport: HappyMcpTransport;
}): Promise<HappyPluginEventRegistration> {
    const lifetime = new AbortController();
    let closing = false;
    let closeTask: Promise<void> | undefined;
    let currentGeneration: RegistrationGeneration | undefined;
    let failure: string | undefined;
    let latestRegistrationId = "";
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let recovery: Promise<void> | undefined;
    let status: HappyPluginStreamStatus = "reconnecting";

    const unregister = (registrationId: string) =>
        options.transport
            .request("DELETE", options.deletePath(registrationId), emptyResponseSchema)
            .catch(() => undefined);
    const unregisterUnattached = async (generation: RegistrationGeneration): Promise<void> => {
        if (currentGeneration !== generation || generation.stream !== undefined) return;
        currentGeneration = undefined;
        await unregister(generation.registrationId);
    };

    const registerAndOpen = async (): Promise<void> => {
        const response = await options.transport.request(
            "POST",
            options.registerPath,
            registerHappyPluginStreamResponseSchema,
            options.registerBody,
        );
        const generation: RegistrationGeneration = {
            registrationId: response.registrationId,
        };
        currentGeneration = generation;
        latestRegistrationId = generation.registrationId;
        if (closing) {
            await unregisterUnattached(generation);
            return;
        }

        let opened: HappyPluginEventStream;
        try {
            opened = await openHappyPluginEventStream({
                eventSchema: options.eventSchema,
                label: options.label,
                onEvent: (event) => options.onEvent(event, generation.registrationId),
                path: options.eventPath(generation.registrationId),
                socketPath: options.transport.socketPath,
                token: options.transport.token,
            });
            generation.stream = opened;
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
            options.onGenerationClosed?.(generation.registrationId);
            failure = error.message;
            status = options.recover === false ? "closed" : "reconnecting";
            if (options.recover === false) {
                warn(`The Happy ${options.label} stream closed. ${error.message}`);
                return;
            }
            warn(
                `The Happy ${options.label} stream closed; the SDK will reconnect. ${error.message}`,
            );
            // The daemon retires the registration when this attached stream closes. Recovery uses
            // a new registration generation, matching the MCP stream lifecycle.
            beginRecovery();
        });
    };

    const beginRecovery = () => {
        if (closing || recovery !== undefined) return;
        const task = (async () => {
            while (!closing) {
                try {
                    const delayMs = reconnectDelayMs;
                    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAXIMUM_RECONNECT_DELAY_MS);
                    await waitForReconnect(delayMs, lifetime.signal);
                    if (closing) return;
                    await registerAndOpen();
                    if (status === "connected" || closing) return;
                } catch (error) {
                    if (closing) return;
                    failure = errorToMessage(error);
                    status = "reconnecting";
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
            const task = (async () => {
                if (generation !== undefined) {
                    await unregister(generation.registrationId);
                }
                stream?.close();
                if (stream !== undefined) await stream.closed;
                if (recoveryTask !== undefined) await recoveryTask;
            })();
            closeTask = task;
            return task;
        },
    };
}

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("Plugin stream recovery stopped."));
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        timer.unref();
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("Plugin stream recovery stopped."));
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Plugin logging is diagnostic and cannot break stream recovery.
    }
}
