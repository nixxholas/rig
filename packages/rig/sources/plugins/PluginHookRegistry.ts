import { randomUUID } from "node:crypto";

import type {
    HappySystemPromptHookCompletion,
    HappySystemPromptHookEvent,
    HappySystemPromptHookInput,
    HappyTracingEvent,
} from "happy-plugins";
import {
    HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES,
    HAPPY_PLUGIN_TRACING_QUEUE_SIZE,
} from "happy-plugins";

const DEFAULT_CHAIN_DEADLINE_MS = 5_000;
const DEFAULT_HOOK_DEADLINE_MS = 2_000;

type HookLogger = (
    level: "warning",
    event: string,
    message: string,
    details: Readonly<Record<string, boolean | number | string | undefined>>,
) => void;

interface HookRegistration {
    attached?: (event: HappySystemPromptHookEvent) => void;
    id: string;
    pending: Map<string, (completion: HappySystemPromptHookCompletion | undefined) => void>;
}

interface TraceRegistration {
    attached?: (event: HappyTracingEvent) => boolean;
    blocked: boolean;
    dropped: number;
    id: string;
    queue: HappyTracingEvent[];
}

interface ConnectionState {
    closed: boolean;
    folder: string;
    generation: string;
    hook?: HookRegistration;
    name: string;
    onRequiredRegistrationRetired?: (retirement: PluginHookRegistrationRetirement) => void;
    tracing?: TraceRegistration;
}

export type PluginHookRegistrationRetirement =
    | { reason: string; status: "failed" }
    | { reason: string; status: "stopped" };

export interface PluginHookConnectionOptions {
    onRequiredRegistrationRetired?: (retirement: PluginHookRegistrationRetirement) => void;
}

export interface PluginHookConnection {
    readonly folder: string;
    readonly generation: string;
    attachSystemPrompt(
        registrationId: string,
        send: (event: HappySystemPromptHookEvent) => void,
    ): () => void;
    attachTracing(registrationId: string, send: (event: HappyTracingEvent) => boolean): () => void;
    close(): void;
    completeSystemPrompt(
        registrationId: string,
        callId: string,
        completion: HappySystemPromptHookCompletion,
    ): void;
    drainTracing(registrationId: string): void;
    registerSystemPrompt(): string;
    registerTracing(): string;
    unregisterSystemPrompt(registrationId: string): void;
    unregisterTracing(registrationId: string): void;
}

export interface PluginHookRegistryOptions {
    chainDeadlineMs?: number;
    deadlineMs?: number;
    log?: HookLogger;
    now?: () => number;
}

/**
 * Owns provider-neutral plugin prompt middleware and non-blocking lifecycle observations.
 *
 * Every connection represents one plugin process generation. A newer generation for the same
 * folder immediately supersedes the old one, even while old process cleanup is still unwinding.
 */
export class PluginHookRegistry {
    readonly #chainDeadlineMs: number;
    readonly #connections = new Set<ConnectionState>();
    readonly #currentByFolder = new Map<string, ConnectionState>();
    readonly #deadlineMs: number;
    readonly #log: HookLogger | undefined;
    readonly #now: () => number;

    constructor(options: PluginHookRegistryOptions = {}) {
        this.#chainDeadlineMs = options.chainDeadlineMs ?? DEFAULT_CHAIN_DEADLINE_MS;
        this.#deadlineMs = options.deadlineMs ?? DEFAULT_HOOK_DEADLINE_MS;
        this.#log = options.log;
        this.#now = options.now ?? Date.now;
    }

    createConnection(
        plugin: { folder: string; name: string },
        options: PluginHookConnectionOptions = {},
    ): PluginHookConnection {
        const previous = this.#currentByFolder.get(plugin.folder);
        if (previous !== undefined) {
            this.#retireState(previous, "replaced");
        }
        const state: ConnectionState = {
            closed: false,
            folder: plugin.folder,
            generation: randomUUID(),
            name: plugin.name,
            ...(options.onRequiredRegistrationRetired === undefined
                ? {}
                : {
                      onRequiredRegistrationRetired: options.onRequiredRegistrationRetired,
                  }),
        };
        this.#connections.add(state);
        this.#currentByFolder.set(state.folder, state);

        const assertActive = () => {
            if (!this.#isCurrent(state)) {
                throw new Error("This plugin hook connection is no longer active.");
            }
        };
        const requireHook = (registrationId: string): HookRegistration => {
            assertActive();
            const hook = state.hook;
            if (hook === undefined || hook.id !== registrationId) {
                throw new Error("That system-prompt hook registration is not active.");
            }
            return hook;
        };
        const requireTracing = (registrationId: string): TraceRegistration => {
            assertActive();
            const tracing = state.tracing;
            if (tracing === undefined || tracing.id !== registrationId) {
                throw new Error("That tracing subscription is not active.");
            }
            return tracing;
        };
        const close = () => {
            if (state.closed) return;
            this.#retireState(state, "closed");
        };

        return {
            folder: state.folder,
            generation: state.generation,
            attachSystemPrompt: (registrationId, send) => {
                const hook = requireHook(registrationId);
                hook.attached = send;
                return () => {
                    if (hook.attached !== send || state.hook !== hook) return;
                    this.#retireHook(state, "stream_closed");
                };
            },
            attachTracing: (registrationId, send) => {
                const tracing = requireTracing(registrationId);
                tracing.attached = send;
                tracing.blocked = false;
                return () => {
                    if (tracing.attached !== send || state.tracing !== tracing) return;
                    this.#retireTracing(state, "stream_closed");
                };
            },
            close,
            completeSystemPrompt: (registrationId, callId, completion) => {
                const hook = requireHook(registrationId);
                const settle = hook.pending.get(callId);
                if (settle === undefined) {
                    throw new Error("That system-prompt hook call is no longer active.");
                }
                hook.pending.delete(callId);
                settle(completion);
            },
            drainTracing: (registrationId) => {
                const tracing = requireTracing(registrationId);
                tracing.blocked = false;
                this.#flushTracing(tracing);
            },
            registerSystemPrompt: () => {
                assertActive();
                if (state.hook !== undefined) {
                    throw new Error("This plugin already registered a system-prompt hook.");
                }
                const id = randomUUID();
                state.hook = { id, pending: new Map() };
                return id;
            },
            registerTracing: () => {
                assertActive();
                if (state.tracing !== undefined) {
                    throw new Error("This plugin already registered a tracing subscription.");
                }
                const id = randomUUID();
                state.tracing = { blocked: false, dropped: 0, id, queue: [] };
                return id;
            },
            unregisterSystemPrompt: (registrationId) => {
                if (!this.#isCurrent(state) || state.hook?.id !== registrationId) return;
                this.#retireHook(state, "unregistered");
            },
            unregisterTracing: (registrationId) => {
                if (!this.#isCurrent(state) || state.tracing?.id !== registrationId) return;
                this.#retireTracing(state, "unregistered");
            },
        };
    }

    async applySystemPrompt(input: HappySystemPromptHookInput): Promise<string> {
        if (
            Buffer.byteLength(input.systemPrompt, "utf8") +
                Buffer.byteLength(input.userPrompt, "utf8") >
            HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES
        ) {
            this.#log?.(
                "warning",
                "plugin_system_prompt_payload_skipped",
                "Rig skipped plugin system-prompt hooks because the prompt payload was too large.",
                {},
            );
            return input.systemPrompt;
        }

        let systemPrompt = input.systemPrompt;
        const chainStartedAt = this.#now();
        const connections = [...this.#connections]
            .filter((connection) => this.#isCurrent(connection) && connection.hook !== undefined)
            .sort(
                (left, right) =>
                    left.folder.localeCompare(right.folder) ||
                    left.generation.localeCompare(right.generation),
            );
        for (let index = 0; index < connections.length; index += 1) {
            const connection = connections[index]!;
            const remainingMs = this.#chainDeadlineMs - (this.#now() - chainStartedAt);
            if (remainingMs <= 0) {
                this.#log?.(
                    "warning",
                    "plugin_system_prompt_chain_budget_exhausted",
                    "Rig skipped the remaining plugin system-prompt hooks because the chain deadline was exhausted.",
                    { skippedCount: connections.length - index },
                );
                break;
            }
            const hook = connection.hook;
            if (!this.#isCurrent(connection) || hook === undefined) continue;
            if (hook.attached === undefined) {
                this.#log?.(
                    "warning",
                    "plugin_system_prompt_hook_unavailable",
                    `Rig skipped the ${connection.name} plugin's system-prompt hook because its stream is not attached.`,
                    { plugin: connection.name, pluginFolder: connection.folder },
                );
                continue;
            }

            const callId = randomUUID();
            const event: HappySystemPromptHookEvent = {
                callId,
                input: { systemPrompt, userPrompt: input.userPrompt },
                type: "system_prompt",
            };
            const callDeadlineMs = Math.min(this.#deadlineMs, remainingMs);
            const completion = await new Promise<HappySystemPromptHookCompletion | undefined>(
                (resolve) => {
                    let settled = false;
                    const finish = (value: HappySystemPromptHookCompletion | undefined) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        hook.pending.delete(callId);
                        resolve(value);
                    };
                    const timer = setTimeout(() => finish(undefined), callDeadlineMs);
                    timer.unref();
                    hook.pending.set(callId, finish);
                    try {
                        hook.attached!(event);
                    } catch {
                        finish(undefined);
                    }
                },
            );
            if (!this.#isCurrent(connection) || connection.hook !== hook) {
                this.#log?.(
                    "warning",
                    "plugin_system_prompt_stale_generation_skipped",
                    `Rig skipped a system-prompt result from an old ${connection.name} plugin generation.`,
                    { plugin: connection.name, pluginFolder: connection.folder },
                );
                continue;
            }
            if (completion === undefined) {
                this.#log?.(
                    "warning",
                    "plugin_system_prompt_hook_missed",
                    `Rig skipped the ${connection.name} plugin's system-prompt hook because it did not answer before the deadline.`,
                    { plugin: connection.name, pluginFolder: connection.folder },
                );
                continue;
            }
            const replacement = completion.result.systemPrompt;
            if (replacement === undefined) continue;
            if (!fitsPromptLimit(replacement)) {
                this.#log?.(
                    "warning",
                    "plugin_system_prompt_result_skipped",
                    `Rig skipped the ${connection.name} plugin's oversized system-prompt replacement.`,
                    { plugin: connection.name, pluginFolder: connection.folder },
                );
                continue;
            }
            systemPrompt = replacement;
        }
        return systemPrompt;
    }

    emit(event: HappyTracingEvent): void {
        for (const connection of this.#connections) {
            if (!this.#isCurrent(connection)) continue;
            const tracing = connection.tracing;
            if (tracing === undefined) continue;
            tracing.queue.push(event);
            if (tracing.queue.length > HAPPY_PLUGIN_TRACING_QUEUE_SIZE) {
                tracing.queue.shift();
                tracing.dropped += 1;
                if (tracing.dropped === 1 || tracing.dropped % 64 === 0) {
                    this.#log?.(
                        "warning",
                        "plugin_tracing_events_dropped",
                        `Rig dropped ${String(tracing.dropped)} tracing events for the ${connection.name} plugin because it was reading too slowly.`,
                        {
                            droppedCount: tracing.dropped,
                            plugin: connection.name,
                            pluginFolder: connection.folder,
                        },
                    );
                }
            }
            this.#flushTracing(tracing);
        }
    }

    #flushTracing(tracing: TraceRegistration): void {
        if (tracing.blocked || tracing.attached === undefined) return;
        while (tracing.queue.length > 0) {
            const event = tracing.queue.shift()!;
            try {
                if (tracing.attached(event)) continue;
                tracing.blocked = true;
                return;
            } catch {
                tracing.blocked = true;
                return;
            }
        }
    }

    #isCurrent(state: ConnectionState): boolean {
        return !state.closed && this.#currentByFolder.get(state.folder) === state;
    }

    #retireHook(
        state: ConnectionState,
        reason: "closed" | "replaced" | "stream_closed" | "unregistered",
    ): void {
        const hook = state.hook;
        if (hook === undefined) return;
        const wasAttached = hook.attached !== undefined;
        delete state.hook;
        delete hook.attached;
        for (const settle of hook.pending.values()) settle(undefined);
        hook.pending.clear();
        if (reason === "stream_closed") {
            this.#log?.(
                "warning",
                "plugin_system_prompt_stream_closed",
                `Rig retired the ${state.name} plugin's system-prompt hook because its stream closed.`,
                { plugin: state.name, pluginFolder: state.folder },
            );
        }
        if (wasAttached) {
            state.onRequiredRegistrationRetired?.(
                reason === "unregistered"
                    ? {
                          reason: "The plugin unregistered its system-prompt hook.",
                          status: "stopped",
                      }
                    : {
                          reason:
                              reason === "stream_closed"
                                  ? "The plugin system-prompt hook connection closed."
                                  : reason === "replaced"
                                    ? "A newer plugin process replaced this system-prompt hook."
                                    : "The plugin process stopped.",
                          status: "failed",
                      },
            );
        }
    }

    #retireState(state: ConnectionState, reason: "closed" | "replaced"): void {
        if (state.closed) return;
        state.closed = true;
        this.#retireHook(state, reason);
        this.#retireTracing(state, reason);
        this.#connections.delete(state);
        if (this.#currentByFolder.get(state.folder) === state) {
            this.#currentByFolder.delete(state.folder);
        }
    }

    #retireTracing(
        state: ConnectionState,
        reason: "closed" | "replaced" | "stream_closed" | "unregistered",
    ): void {
        const tracing = state.tracing;
        if (tracing === undefined) return;
        delete state.tracing;
        delete tracing.attached;
        tracing.queue.length = 0;
        tracing.blocked = false;
        if (reason === "stream_closed") {
            this.#log?.(
                "warning",
                "plugin_tracing_stream_closed",
                `Rig retired the ${state.name} plugin's tracing subscription because its stream closed.`,
                { plugin: state.name, pluginFolder: state.folder },
            );
        }
    }
}

function fitsPromptLimit(value: string): boolean {
    return Buffer.byteLength(value, "utf8") <= HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES;
}
