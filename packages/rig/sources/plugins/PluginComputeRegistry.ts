import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
    HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
    type ExecHappyComputeHandlerInput,
    type HappyComputeError,
    type HappyComputeErrorCode,
    type HappyComputeProvider,
    type HappyComputeProviderManifest,
    type ReadHappyComputeInput,
    type StartHappyComputeInput,
    type WriteHappyComputeInput,
} from "happy-plugins";
import {
    happyComputeCallCompletionSchema,
    normalizeHappyComputeError,
    type HappyComputeCallCompletion,
    type HappyComputeEvent,
} from "happy-plugins/internal";

const DEFAULT_OPERATION_DEADLINE_MS = 10_000;
const DEFAULT_START_DEADLINE_MS = 30_000;
const EXEC_DEADLINE_GRACE_MS = 2_000;
const MAX_ACTIVE_COMPUTE_INSTANCES = 256;
const MAX_PENDING_COMPUTE_CALLS = 256;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;

export const MAX_COMPUTE_INSTANCE_LIFETIME_MS = 2 * 60 * 60_000;
export const MAX_COMPUTE_INSTANCE_IDLE_MS = 30 * 60_000;

type ComputeOperation = "exec" | "read" | "start" | "stop" | "write";
type ComputeCallEvent = Extract<HappyComputeEvent, { type: "call" }>;
type WithoutComputeCallEnvelope<T> = T extends ComputeCallEvent
    ? Omit<T, "callId" | "type">
    : never;
type ComputeCallPayload<T extends ComputeOperation> = Extract<
    WithoutComputeCallEnvelope<ComputeCallEvent>,
    { operation: T }
>;
type ComputeErrorCompletion = Extract<HappyComputeCallCompletion, { error: HappyComputeError }>;
type ComputeOperationCompletion<T extends ComputeOperation> =
    | ComputeErrorCompletion
    | Extract<HappyComputeCallCompletion, { operation: T }>;
type ComputeOperationResult<T extends ComputeOperation> =
    Extract<HappyComputeCallCompletion, { operation: T }> extends { result: infer TResult }
        ? TResult
        : never;

type ComputeProviderState =
    | { status: "registered" }
    | {
          consecutiveFailures: 0 | 1;
          send: (event: HappyComputeEvent) => boolean;
          status: "healthy";
      }
    | {
          consecutiveFailures: 2;
          send: (event: HappyComputeEvent) => boolean;
          status: "degraded";
      }
    | { reason: string; status: "failed" };

type PendingComputeCall = {
    cleanup(): void;
    operation: ComputeOperation;
    reject(error: PluginComputeError): void;
    resolve(completion: HappyComputeCallCompletion): void;
};

type ComputeOwner = {
    compute?: HappyComputeProviderManifest;
    folder: string;
    generation: string;
    name: string;
};

type ComputeRegistration = {
    id: string;
    onRequiredRegistrationRetired?: (retirement: PluginComputeRegistrationRetirement) => void;
    owner: ComputeOwner;
    pendingCalls: Map<string, PendingComputeCall>;
    state: ComputeProviderState;
};

type ComputeInstanceBase = {
    consumerGeneration: string;
    createdAt: number;
    id: string;
    lastTouchedAt: number;
    providerInstanceId: string;
    registration: ComputeRegistration;
};

type ComputeInstance =
    | (ComputeInstanceBase & { state: "active" })
    | (ComputeInstanceBase & { failure: string; state: "failed" })
    | (ComputeInstanceBase & { reason: string; state: "stopping"; task: Promise<void> });

export interface PluginComputeConnection {
    readonly generation: string;
    attach(registrationId: string, send: (event: HappyComputeEvent) => boolean): () => void;
    assertReady(): void;
    close(): void;
    complete(registrationId: string, callId: string, completion: unknown): void;
    register(): string;
    unregister(registrationId: string): void;
}

export type PluginComputeRegistrationRetirement =
    | { reason: string; status: "failed" }
    | { reason: string; status: "stopped" };

export interface PluginComputeConnectionOptions {
    onRequiredRegistrationRetired?: (retirement: PluginComputeRegistrationRetirement) => void;
}

export class PluginComputeError extends Error {
    readonly code: HappyComputeErrorCode;
    readonly retryable: boolean;

    constructor(error: HappyComputeError) {
        super(error.message);
        this.name = "PluginComputeError";
        this.code = error.code;
        this.retryable = error.retryable;
    }
}

export interface PluginComputeRegistryOptions {
    /** Overrides every operation deadline. Intended for deterministic tests. */
    callTimeoutMs?: number;
    idleTimeoutMs?: number;
    log?: (
        level: "info" | "warning",
        event: string,
        message: string,
        details: Readonly<Record<string, number | string | undefined>>,
    ) => void;
    /** Lowers the daemon-wide instance budget. Intended for deterministic tests. */
    maxInstances?: number;
    maxLifetimeMs?: number;
    now?: () => number;
    reaperIntervalMs?: number;
}

/**
 * Daemon-wide compute catalog and provider-generation state machine.
 *
 * Public instance IDs map to provider-private IDs and one plugin generation. A provider can recover
 * from two consecutive attributable failures, but its third failure or stream loss is terminal for
 * that generation.
 */
export class PluginComputeRegistry {
    readonly #callTimeoutMs: number | undefined;
    readonly #consumerGenerations = new Set<string>();
    readonly #idleTimeoutMs: number;
    readonly #instances = new Map<string, ComputeInstance>();
    readonly #listeners = new Set<() => void>();
    readonly #log: NonNullable<PluginComputeRegistryOptions["log"]>;
    readonly #maxInstances: number;
    readonly #maxLifetimeMs: number;
    readonly #now: () => number;
    readonly #registrations = new Map<string, ComputeRegistration>();
    readonly #reaper: NodeJS.Timeout;
    #closeTask: Promise<void> | undefined;
    #closed = false;
    #reservedInstanceSlots = 0;

    constructor(options: PluginComputeRegistryOptions = {}) {
        this.#callTimeoutMs = options.callTimeoutMs;
        this.#idleTimeoutMs = Math.min(
            options.idleTimeoutMs ?? MAX_COMPUTE_INSTANCE_IDLE_MS,
            MAX_COMPUTE_INSTANCE_IDLE_MS,
        );
        this.#log = options.log ?? (() => undefined);
        this.#maxInstances = Math.min(
            options.maxInstances ?? MAX_ACTIVE_COMPUTE_INSTANCES,
            MAX_ACTIVE_COMPUTE_INSTANCES,
        );
        this.#maxLifetimeMs = Math.min(
            options.maxLifetimeMs ?? MAX_COMPUTE_INSTANCE_LIFETIME_MS,
            MAX_COMPUTE_INSTANCE_LIFETIME_MS,
        );
        this.#now = options.now ?? Date.now;
        this.#reaper = setInterval(
            () => this.#reapExpiredInstances(),
            Math.min(
                options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS,
                this.#idleTimeoutMs,
                this.#maxLifetimeMs,
            ),
        );
        this.#reaper.unref();
    }

    createConnection(
        plugin: {
            compute?: HappyComputeProviderManifest;
            folder: string;
            name: string;
        },
        options: PluginComputeConnectionOptions = {},
    ): PluginComputeConnection {
        if (this.#closed) throw new Error("Rig is shutting down, so compute is unavailable.");
        const owner: ComputeOwner = { ...plugin, generation: randomUUID() };
        this.#consumerGenerations.add(owner.generation);
        let ownerClosed = false;
        const owned = () =>
            [...this.#registrations.values()].filter(
                (registration) => registration.owner.generation === owner.generation,
            );
        const requireOwned = (registrationId: string) => {
            const registration = this.#registrations.get(registrationId);
            if (registration?.owner.generation !== owner.generation) {
                throw computeError(
                    "invalid_request",
                    "That compute registration does not belong to this plugin process.",
                );
            }
            return registration;
        };
        return {
            generation: owner.generation,
            attach: (registrationId, send) => {
                const registration = requireOwned(registrationId);
                if (registration.state.status !== "registered") {
                    throw computeError(
                        "invalid_request",
                        "That plugin compute registration is already connected.",
                    );
                }
                registration.state = {
                    consecutiveFailures: 0,
                    send,
                    status: "healthy",
                };
                this.#notify();
                let attached = true;
                return () => {
                    if (!attached) return;
                    attached = false;
                    this.#loseProvider(registration, "The plugin compute connection closed.");
                };
            },
            assertReady: () => {
                if (owner.compute === undefined) return;
                if (
                    !owned().some(
                        (registration) =>
                            registration.state.status === "healthy" ||
                            registration.state.status === "degraded",
                    )
                ) {
                    throw computeError(
                        "invalid_request",
                        `The plugin must register and attach its "${owner.compute.name}" compute provider before reporting ready.`,
                    );
                }
            },
            close: () => {
                if (ownerClosed) return;
                ownerClosed = true;
                this.#consumerGenerations.delete(owner.generation);
                this.#releaseConsumerInstances(owner.generation);
                for (const registration of owned()) {
                    this.#loseProvider(registration, "The compute provider plugin stopped.");
                    this.#removeRegistration(registration);
                }
            },
            complete: (registrationId, callId, completion) => {
                const registration = requireOwned(registrationId);
                const call = registration.pendingCalls.get(callId);
                if (call === undefined) {
                    throw computeError(
                        "invalid_request",
                        "That plugin compute call is no longer active.",
                    );
                }
                let decoded: HappyComputeCallCompletion;
                try {
                    decoded = Value.Decode(happyComputeCallCompletionSchema, completion);
                    if ("operation" in decoded && decoded.operation !== call.operation) {
                        throw new Error(
                            `The plugin completed a ${call.operation} compute call with a ${decoded.operation} result.`,
                        );
                    }
                } catch (error) {
                    const failure = `The compute provider returned an invalid ${call.operation} response. ${errorToMessage(error)}`;
                    this.#recordProviderFailure(registration, failure);
                    if (registration.pendingCalls.get(callId) === call) {
                        registration.pendingCalls.delete(callId);
                        call.cleanup();
                        call.reject(computeError("invalid_response", failure));
                    }
                    throw computeError("invalid_response", failure);
                }
                if ("error" in decoded) {
                    if (isProviderAttributableCompletionError(decoded.error.code)) {
                        this.#recordProviderFailure(registration, decoded.error.message);
                    }
                    decoded = {
                        error: normalizeHappyComputeError(
                            decoded.error,
                            registration.state.status === "registered"
                                ? "failed"
                                : registration.state.status,
                        ),
                    };
                }
                if (registration.pendingCalls.get(callId) !== call) return;
                registration.pendingCalls.delete(callId);
                call.cleanup();
                call.resolve(decoded);
            },
            register: () => {
                if (ownerClosed || this.#closed) {
                    throw computeError(
                        "invalid_request",
                        "The plugin process is stopping, so it cannot register compute.",
                    );
                }
                if (owner.compute === undefined) {
                    throw computeError(
                        "invalid_request",
                        "This plugin did not declare a compute provider in happy.plugin.json.",
                    );
                }
                if (owned().length > 0) {
                    throw computeError(
                        "invalid_request",
                        "This plugin process already registered its compute provider.",
                    );
                }
                const key = owner.compute.name.toLowerCase();
                if (
                    [...this.#registrations.values()].some(
                        (registration) => registration.owner.compute?.name.toLowerCase() === key,
                    )
                ) {
                    throw computeError(
                        "invalid_request",
                        `A compute provider named "${owner.compute.name}" is already registered.`,
                    );
                }
                const id = randomUUID();
                this.#registrations.set(id, {
                    id,
                    ...(options.onRequiredRegistrationRetired === undefined
                        ? {}
                        : {
                              onRequiredRegistrationRetired: options.onRequiredRegistrationRetired,
                          }),
                    owner,
                    pendingCalls: new Map(),
                    state: { status: "registered" },
                });
                return id;
            },
            unregister: (registrationId) => {
                const registration = requireOwned(registrationId);
                const wasCallable =
                    registration.state.status === "healthy" ||
                    registration.state.status === "degraded";
                this.#failProviderGeneration(
                    registration,
                    "The plugin unregistered its compute provider.",
                );
                this.#removeRegistration(registration);
                if (wasCallable) {
                    registration.onRequiredRegistrationRetired?.({
                        reason: "The plugin unregistered its compute provider.",
                        status: "stopped",
                    });
                }
            },
        };
    }

    list(): readonly HappyComputeProvider[] {
        return [...this.#registrations.values()]
            .flatMap((registration): HappyComputeProvider[] => {
                if (
                    registration.owner.compute === undefined ||
                    registration.state.status === "registered"
                ) {
                    return [];
                }
                return [
                    {
                        health: registration.state.status,
                        name: registration.owner.compute.name,
                        pluginFolder: registration.owner.folder,
                        pluginName: registration.owner.name,
                    },
                ];
            })
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async start(input: StartHappyComputeInput, consumerGeneration: string) {
        if (!this.#consumerGenerations.has(consumerGeneration)) {
            throw computeError(
                "provider_lost",
                "The compute consumer generation is no longer active.",
            );
        }
        const registration = [...this.#registrations.values()].find(
            (candidate) =>
                candidate.state.status !== "registered" &&
                candidate.owner.compute?.name.toLowerCase() === input.provider.toLowerCase(),
        );
        if (registration === undefined) {
            throw computeError(
                "provider_not_found",
                `No running compute provider is named "${input.provider}".`,
            );
        }
        if (registration.state.status === "failed") {
            throw computeError(
                "provider_unhealthy",
                `The "${input.provider}" compute provider is unhealthy until its plugin restarts.`,
            );
        }
        if (this.#instances.size + this.#reservedInstanceSlots >= this.#maxInstances) {
            throw computeError(
                "capacity_exhausted",
                `Rig can keep at most ${String(this.#maxInstances)} compute instances active.`,
                true,
            );
        }
        this.#reservedInstanceSlots += 1;
        try {
            const completion = await this.#invoke(
                registration,
                {
                    operation: "start",
                    workspaceSource: input.workspaceSource,
                },
                this.#deadline("start"),
            );
            if ("error" in completion) throw new PluginComputeError(completion.error);
            const duplicate = [...this.#instances.values()].some(
                (instance) =>
                    instance.registration === registration &&
                    instance.providerInstanceId === completion.result.instanceId,
            );
            if (duplicate) {
                const message =
                    "The compute provider returned an instance ID that is already active.";
                this.#recordProviderFailure(registration, message);
                this.#stopProviderInstanceBestEffort(
                    registration,
                    completion.result.instanceId,
                    "duplicate provider instance",
                );
                throw computeError("invalid_response", message);
            }
            this.#recordProviderSuccess(registration);
            if (
                !this.#isCallableRegistration(registration) ||
                !this.#consumerGenerations.has(consumerGeneration)
            ) {
                this.#stopProviderInstanceBestEffort(
                    registration,
                    completion.result.instanceId,
                    "retired start",
                );
                throw computeError(
                    "provider_lost",
                    "The compute provider or consumer generation retired while it was starting the instance.",
                );
            }
            const now = this.#now();
            const id = randomUUID();
            this.#instances.set(id, {
                consumerGeneration,
                createdAt: now,
                id,
                lastTouchedAt: now,
                providerInstanceId: completion.result.instanceId,
                registration,
                state: "active",
            });
            return { instanceId: id, provider: registration.owner.compute!.name };
        } finally {
            this.#reservedInstanceSlots -= 1;
        }
    }

    async read(input: ReadHappyComputeInput, consumerGeneration: string) {
        const instance = this.#requireCallableInstance(input.instanceId, consumerGeneration);
        return this.#runInstanceCall(instance, "read", {
            instanceId: instance.providerInstanceId,
            operation: "read",
            path: input.path,
        });
    }

    async write(input: WriteHappyComputeInput, consumerGeneration: string): Promise<void> {
        const instance = this.#requireCallableInstance(input.instanceId, consumerGeneration);
        await this.#runInstanceCall(instance, "write", {
            contentBase64: Buffer.from(input.bytes).toString("base64"),
            instanceId: instance.providerInstanceId,
            operation: "write",
            path: input.path,
        });
    }

    async exec(input: ExecHappyComputeHandlerInput, consumerGeneration: string) {
        const instance = this.#requireCallableInstance(input.instanceId, consumerGeneration);
        return this.#runInstanceCall(
            instance,
            "exec",
            {
                command: input.command,
                instanceId: instance.providerInstanceId,
                operation: "exec",
                timeoutMs: input.timeoutMs,
            },
            this.#deadline("exec", input.timeoutMs),
        );
    }

    stop(instanceId: string, consumerGeneration: string): Promise<void> {
        const instance = this.#requireOwnedInstance(instanceId, consumerGeneration);
        return this.#beginStop(instance, "requested by its consumer");
    }

    close(): Promise<void> {
        return (this.#closeTask ??= this.#close());
    }

    async #close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        clearInterval(this.#reaper);
        const stopTasks = [...this.#instances.values()].map((instance) =>
            this.#beginStop(instance, "Rig daemon shutdown"),
        );
        await Promise.all(stopTasks);
        for (const registration of this.#registrations.values()) {
            this.#loseProvider(registration, "Rig shut down the plugin compute catalog.");
            this.#removeRegistration(registration);
        }
        this.#consumerGenerations.clear();
        this.#listeners.clear();
    }

    async #runInstanceCall<T extends Exclude<ComputeOperation, "start" | "stop">>(
        instance: Extract<ComputeInstance, { state: "active" }>,
        operation: T,
        event: ComputeCallPayload<T>,
        deadlineMs = this.#deadline(operation),
    ): Promise<ComputeOperationResult<T>> {
        instance.lastTouchedAt = this.#now();
        const completion = await this.#invoke(instance.registration, event, deadlineMs);
        if ("error" in completion) throw new PluginComputeError(completion.error);
        this.#recordProviderSuccess(instance.registration);
        return (completion as { result: ComputeOperationResult<T> }).result;
    }

    #invoke<T extends ComputeOperation>(
        registration: ComputeRegistration,
        event: ComputeCallPayload<T>,
        deadlineMs: number,
    ): Promise<ComputeOperationCompletion<T>> {
        if (!this.#isCallableRegistration(registration)) {
            return Promise.reject(
                computeError(
                    "provider_lost",
                    "The compute provider generation is no longer connected.",
                ),
            );
        }
        if (registration.pendingCalls.size >= MAX_PENDING_COMPUTE_CALLS) {
            return Promise.reject(
                computeError(
                    "capacity_exhausted",
                    `A compute provider can have at most ${String(MAX_PENDING_COMPUTE_CALLS)} calls in flight.`,
                    true,
                ),
            );
        }
        const callId = randomUUID();
        return new Promise<ComputeOperationCompletion<T>>((resolve, reject) => {
            let settled = false;
            const finish = () => clearTimeout(timer);
            const fail = (error: PluginComputeError) => {
                if (settled) return;
                settled = true;
                registration.pendingCalls.delete(callId);
                finish();
                reject(error);
            };
            const timer = setTimeout(() => {
                const message = `The compute provider missed its ${event.operation} deadline after ${String(deadlineMs)}ms.`;
                const state = registration.state;
                if (state.status === "healthy" || state.status === "degraded") {
                    try {
                        state.send({ callId, type: "cancel" });
                    } catch {
                        // The deadline remains the useful failure if cancellation cannot be sent.
                    }
                }
                this.#recordProviderFailure(registration, message);
                fail(
                    computeError(
                        "deadline_exceeded",
                        message,
                        registration.state.status === "healthy",
                    ),
                );
            }, deadlineMs);
            timer.unref();
            registration.pendingCalls.set(callId, {
                cleanup: finish,
                operation: event.operation,
                reject: fail,
                resolve: (completion) => {
                    if (settled) return;
                    settled = true;
                    finish();
                    resolve(completion as ComputeOperationCompletion<T>);
                },
            });
            try {
                const state = registration.state;
                if (
                    (state.status !== "healthy" && state.status !== "degraded") ||
                    state.send({
                        ...event,
                        callId,
                        type: "call",
                    } as HappyComputeEvent) !== true
                ) {
                    const message =
                        "The compute provider could not receive the requested operation.";
                    this.#recordProviderFailure(registration, message);
                    fail(computeError("invalid_response", message));
                }
            } catch (error) {
                const message = `The compute provider transport failed. ${errorToMessage(error)}`;
                this.#recordProviderFailure(registration, message);
                fail(computeError("invalid_response", message));
            }
        });
    }

    #requireOwnedInstance(instanceId: string, consumerGeneration: string): ComputeInstance {
        const instance = this.#instances.get(instanceId);
        if (instance === undefined || instance.consumerGeneration !== consumerGeneration) {
            throw computeError("instance_not_found", "That compute instance was not found.");
        }
        return instance;
    }

    #requireCallableInstance(
        instanceId: string,
        consumerGeneration: string,
    ): Extract<ComputeInstance, { state: "active" }> {
        const instance = this.#requireOwnedInstance(instanceId, consumerGeneration);
        if (instance.state === "failed") {
            throw computeError("instance_failed", instance.failure);
        }
        if (instance.state === "stopping") {
            throw computeError("instance_not_found", "That compute instance is stopping.");
        }
        return instance;
    }

    #recordProviderSuccess(registration: ComputeRegistration): void {
        const state = registration.state;
        if (state.status === "registered" || state.status === "failed") return;
        const recovered = state.status === "degraded";
        registration.state = {
            consecutiveFailures: 0,
            send: state.send,
            status: "healthy",
        };
        if (recovered) this.#notify();
    }

    #recordProviderFailure(registration: ComputeRegistration, reason: string): void {
        const state = registration.state;
        if (state.status === "registered" || state.status === "failed") return;
        if (state.status === "healthy" && state.consecutiveFailures === 0) {
            registration.state = {
                consecutiveFailures: 1,
                send: state.send,
                status: "healthy",
            };
            return;
        }
        if (state.status === "healthy") {
            registration.state = {
                consecutiveFailures: 2,
                send: state.send,
                status: "degraded",
            };
            this.#notify();
            return;
        }
        this.#failProviderGeneration(registration, reason);
        registration.onRequiredRegistrationRetired?.({
            reason,
            status: "failed",
        });
    }

    #loseProvider(registration: ComputeRegistration, reason: string): void {
        if (registration.state.status === "failed") return;
        const wasVisible = registration.state.status !== "registered";
        this.#failProviderGeneration(registration, reason);
        if (wasVisible) {
            registration.onRequiredRegistrationRetired?.({
                reason,
                status: "failed",
            });
        }
    }

    #failProviderGeneration(registration: ComputeRegistration, reason: string): void {
        if (registration.state.status === "failed") return;
        registration.state = { reason, status: "failed" };
        for (const instance of this.#instances.values()) {
            if (instance.registration !== registration || instance.state !== "active") continue;
            this.#instances.set(instance.id, {
                ...instance,
                failure: `The compute provider failed. ${reason}`,
                state: "failed",
            });
        }
        for (const call of registration.pendingCalls.values()) {
            call.cleanup();
            call.reject(computeError("provider_lost", `The compute provider was lost. ${reason}`));
        }
        registration.pendingCalls.clear();
        this.#notify();
    }

    #removeRegistration(registration: ComputeRegistration): void {
        if (this.#registrations.get(registration.id) !== registration) return;
        this.#registrations.delete(registration.id);
        this.#notify();
    }

    #isCallableRegistration(registration: ComputeRegistration): boolean {
        return (
            this.#registrations.get(registration.id) === registration &&
            (registration.state.status === "healthy" || registration.state.status === "degraded")
        );
    }

    #releaseConsumerInstances(consumerGeneration: string): void {
        for (const instance of this.#instances.values()) {
            if (instance.consumerGeneration !== consumerGeneration) continue;
            void this.#beginStop(instance, "its consumer plugin stopped");
        }
    }

    #beginStop(instance: ComputeInstance, reason: string): Promise<void> {
        const current = this.#instances.get(instance.id);
        if (current === undefined) return Promise.resolve();
        if (current.state === "stopping") return current.task;
        let run = () => undefined;
        const task = new Promise<void>((resolve) => {
            run = () => {
                void this.#finishStop(current, reason).finally(resolve);
            };
        });
        this.#instances.set(current.id, {
            ...current,
            reason,
            state: "stopping",
            task,
        });
        run();
        return task;
    }

    async #finishStop(
        instance: Exclude<ComputeInstance, { state: "stopping" }>,
        reason: string,
    ): Promise<void> {
        try {
            if (this.#isCallableRegistration(instance.registration)) {
                const completion = await this.#invoke(
                    instance.registration,
                    {
                        instanceId: instance.providerInstanceId,
                        operation: "stop",
                    },
                    this.#deadline("stop"),
                );
                if ("error" in completion) {
                    this.#log(
                        "warning",
                        "plugin_compute_cleanup_failed",
                        "A compute provider could not stop an instance.",
                        {
                            instanceId: instance.id,
                            provider: instance.registration.owner.compute?.name,
                            reason,
                            error: completion.error.message,
                        },
                    );
                } else {
                    this.#recordProviderSuccess(instance.registration);
                }
            }
        } catch (error) {
            this.#log(
                "warning",
                "plugin_compute_cleanup_failed",
                "A compute provider could not stop an instance.",
                {
                    instanceId: instance.id,
                    provider: instance.registration.owner.compute?.name,
                    reason,
                    error: errorToMessage(error),
                },
            );
        } finally {
            const current = this.#instances.get(instance.id);
            if (current?.state === "stopping") this.#instances.delete(instance.id);
        }
    }

    #stopProviderInstanceBestEffort(
        registration: ComputeRegistration,
        providerInstanceId: string,
        reason: string,
    ): void {
        if (!this.#isCallableRegistration(registration)) return;
        void this.#invoke(
            registration,
            { instanceId: providerInstanceId, operation: "stop" },
            this.#deadline("stop"),
        )
            .then((completion) => {
                if ("error" in completion) {
                    this.#log(
                        "warning",
                        "plugin_compute_cleanup_failed",
                        "A compute provider could not clean up an unpublished instance.",
                        {
                            provider: registration.owner.compute?.name,
                            providerInstanceId,
                            reason,
                            error: completion.error.message,
                        },
                    );
                } else {
                    this.#recordProviderSuccess(registration);
                }
            })
            .catch((error: unknown) => {
                this.#log(
                    "warning",
                    "plugin_compute_cleanup_failed",
                    "A compute provider could not clean up an unpublished instance.",
                    {
                        provider: registration.owner.compute?.name,
                        providerInstanceId,
                        reason,
                        error: errorToMessage(error),
                    },
                );
            });
    }

    #reapExpiredInstances(): void {
        if (this.#closed) return;
        const now = this.#now();
        for (const instance of this.#instances.values()) {
            if (instance.state === "stopping") continue;
            const lifetime = now - instance.createdAt;
            const idle = now - instance.lastTouchedAt;
            const reason =
                lifetime >= this.#maxLifetimeMs
                    ? `maximum lifetime of ${String(this.#maxLifetimeMs)}ms expired`
                    : idle >= this.#idleTimeoutMs
                      ? `idle timeout of ${String(this.#idleTimeoutMs)}ms expired`
                      : undefined;
            if (reason === undefined) continue;
            this.#log(
                "info",
                "plugin_compute_instance_reaped",
                "Rig automatically stopped an expired compute instance.",
                {
                    idleMs: idle,
                    instanceId: instance.id,
                    lifetimeMs: lifetime,
                    provider: instance.registration.owner.compute?.name,
                    reason,
                },
            );
            void this.#beginStop(instance, reason);
        }
    }

    #deadline(operation: ComputeOperation, commandTimeoutMs?: number): number {
        if (this.#callTimeoutMs !== undefined) return this.#callTimeoutMs;
        if (operation === "start") return DEFAULT_START_DEADLINE_MS;
        if (operation === "exec") {
            return (
                (commandTimeoutMs ?? HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS) +
                EXEC_DEADLINE_GRACE_MS
            );
        }
        return DEFAULT_OPERATION_DEADLINE_MS;
    }

    #notify(): void {
        for (const listener of this.#listeners) listener();
    }
}

function computeError(
    code: HappyComputeErrorCode,
    message: string,
    retryable = false,
): PluginComputeError {
    if (code === "capacity_exhausted") {
        return new PluginComputeError({ code, message, retryable: true });
    }
    if (code === "deadline_exceeded") {
        return new PluginComputeError({ code, message, retryable });
    }
    return new PluginComputeError({ code, message, retryable: false });
}

function isProviderAttributableCompletionError(code: HappyComputeErrorCode): boolean {
    switch (code) {
        case "capacity_exhausted":
        case "instance_not_found":
        case "invalid_request":
        case "provider_not_found":
            return false;
        case "deadline_exceeded":
        case "instance_failed":
        case "invalid_response":
        case "provider_lost":
        case "provider_unhealthy":
            return true;
    }
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
