import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
    HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
    type ExecHappyComputeHandlerInput,
    type HappyComputeError,
    type HappyComputeErrorCode,
    type HappyComputeInstance,
    type HappyComputeInstanceState,
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
const MAX_RETAINED_COMPUTE_TOMBSTONES = 256;
const MAX_PROVISIONING_GRACE_MS = 10_000;
const READINESS_PROBE_COMMAND_TIMEOUT_MS = 5_000;

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
    provider: string;
    registration: ComputeRegistration;
};

type ReadinessSignal = {
    promise: Promise<void>;
    settle(): void;
};

type ComputeInstance =
    | (ComputeInstanceBase & {
          providerInstanceId?: string;
          readiness: ReadinessSignal;
          state: "provisioning";
      })
    | (ComputeInstanceBase & { providerInstanceId: string; state: "ready" })
    | (ComputeInstanceBase & {
          providerInstanceId: string;
          readiness: ReadinessSignal;
          reason: string;
          state: "unavailable";
      });

type ComputeTombstone = {
    consumerGeneration: string;
    createdAt: number;
    diedAt: number;
    id: string;
    provider: string;
    reason: string;
    state: "failed" | "stopped";
};

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
    readonly state: HappyComputeInstanceState | undefined;

    constructor(error: HappyComputeError) {
        super(error.message);
        this.name = "PluginComputeError";
        this.code = error.code;
        this.retryable = error.retryable;
        this.state = error.state;
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
    maxTombstones?: number;
    now?: () => number;
    provisioningGraceMs?: number;
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
    readonly #maxTombstones: number;
    readonly #now: () => number;
    readonly #provisioningGraceMs: number;
    readonly #registrations = new Map<string, ComputeRegistration>();
    readonly #recoveryTasks = new Map<string, Promise<void>>();
    readonly #reaper: NodeJS.Timeout;
    readonly #stopTasks = new Map<string, Promise<void>>();
    readonly #tombstones = new Map<string, ComputeTombstone>();
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
        this.#maxTombstones = Math.min(
            options.maxTombstones ?? MAX_RETAINED_COMPUTE_TOMBSTONES,
            MAX_RETAINED_COMPUTE_TOMBSTONES,
        );
        this.#now = options.now ?? Date.now;
        this.#provisioningGraceMs = Math.min(
            options.provisioningGraceMs ?? MAX_PROVISIONING_GRACE_MS,
            MAX_PROVISIONING_GRACE_MS,
        );
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
                        error: normalizeHappyComputeError(decoded.error),
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

    listInstances(consumerGeneration: string): readonly HappyComputeInstance[] {
        return [
            ...[...this.#instances.values()]
                .filter((instance) => instance.consumerGeneration === consumerGeneration)
                .map((instance) => this.#toHappyComputeInstance(instance)),
            ...[...this.#tombstones.values()]
                .filter((tombstone) => tombstone.consumerGeneration === consumerGeneration)
                .map((tombstone) => this.#toHappyComputeInstance(tombstone)),
        ].sort(
            (left, right) =>
                left.createdAt - right.createdAt || left.instanceId.localeCompare(right.instanceId),
        );
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
            );
        }
        this.#reservedInstanceSlots += 1;
        const createdAt = this.#now();
        const id = randomUUID();
        const readiness = createReadinessSignal();
        const instance: ComputeInstance = {
            consumerGeneration,
            createdAt,
            id,
            lastTouchedAt: createdAt,
            provider: registration.owner.compute!.name,
            readiness,
            registration,
            state: "provisioning",
        };
        this.#instances.set(id, instance);
        const startDeadlineAt = Date.now() + this.#deadline("start");
        try {
            const completion = await this.#invoke(
                registration,
                {
                    operation: "start",
                    workspaceSource: input.workspaceSource,
                },
                remainingDeadline(startDeadlineAt),
            );
            if ("error" in completion) {
                const error =
                    completion.error.code === "not_ready"
                        ? computeError(
                              "invalid_response",
                              "The provider reported not_ready before materializing an instance.",
                              "failed",
                          )
                        : computeError(completion.error.code, completion.error.message, "failed");
                this.#terminalizeInstance(
                    instance,
                    "failed",
                    `The compute provider could not provision the instance. ${error.message}`,
                );
                throw error;
            }
            const duplicate = [...this.#instances.values()].some(
                (candidate) =>
                    candidate !== instance &&
                    candidate.registration === registration &&
                    candidate.providerInstanceId === completion.result.instanceId,
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
                this.#terminalizeInstance(instance, "failed", message);
                throw computeError("invalid_response", message, "failed");
            }
            const current = this.#instances.get(id);
            if (current?.state !== "provisioning") {
                this.#stopProviderInstanceBestEffort(
                    registration,
                    completion.result.instanceId,
                    "retired provisioning",
                );
                throw this.#terminalInstanceError(id, consumerGeneration);
            }
            this.#instances.set(id, {
                ...current,
                providerInstanceId: completion.result.instanceId,
            });
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
                    "failed",
                );
            }
            const probe = await this.#invoke(
                registration,
                {
                    command: "true",
                    instanceId: completion.result.instanceId,
                    operation: "exec",
                    timeoutMs: Math.min(
                        READINESS_PROBE_COMMAND_TIMEOUT_MS,
                        remainingDeadline(startDeadlineAt),
                    ),
                },
                remainingDeadline(startDeadlineAt),
            );
            this.#requireProvisioningInstance(id, consumerGeneration);
            if ("error" in probe) {
                const unavailable = this.#transitionInstanceUnavailable(
                    id,
                    `The readiness probe failed. ${probe.error.message}`,
                );
                throw computeError("not_ready", unavailable.reason, "unavailable");
            }
            if (probe.result.exitCode !== 0 || probe.result.timedOut) {
                const reason = probe.result.timedOut
                    ? "The compute instance readiness probe timed out."
                    : `The compute instance readiness probe exited with code ${String(probe.result.exitCode)}.`;
                this.#recordProviderFailure(registration, reason);
                if (!this.#isCallableRegistration(registration)) {
                    throw this.#terminalInstanceError(id, consumerGeneration);
                }
                this.#requireProvisioningInstance(id, consumerGeneration);
                this.#transitionInstanceUnavailable(id, reason);
                throw computeError("not_ready", reason, "unavailable");
            }
            this.#recordProviderSuccess(registration);
            this.#requireProvisioningInstance(id, consumerGeneration);
            const ready = this.#transitionInstanceReady(id);
            return this.#toHappyComputeInstance(ready);
        } catch (error) {
            const current = this.#instances.get(id);
            if (current?.state === "provisioning" && current.providerInstanceId === undefined) {
                this.#terminalizeInstance(
                    current,
                    "failed",
                    `The compute instance failed during provisioning. ${errorToMessage(error)}`,
                );
            } else if (current?.state === "provisioning") {
                const unavailable = this.#transitionInstanceUnavailable(
                    id,
                    `The readiness probe could not complete. ${errorToMessage(error)}`,
                );
                throw computeError("not_ready", unavailable.reason, "unavailable");
            }
            const tombstone = this.#tombstones.get(id);
            if (
                tombstone?.consumerGeneration === consumerGeneration &&
                error instanceof PluginComputeError &&
                error.state === undefined
            ) {
                throw computeError(
                    error.code,
                    `${error.message} ${tombstone.reason}`,
                    tombstone.state,
                );
            }
            throw error;
        } finally {
            this.#reservedInstanceSlots -= 1;
        }
    }

    async read(input: ReadHappyComputeInput, consumerGeneration: string) {
        const instance = await this.#requireReadyInstance(input.instanceId, consumerGeneration);
        return this.#runInstanceCall(instance, "read", {
            instanceId: instance.providerInstanceId,
            operation: "read",
            path: input.path,
        });
    }

    async write(input: WriteHappyComputeInput, consumerGeneration: string): Promise<void> {
        const instance = await this.#requireReadyInstance(input.instanceId, consumerGeneration);
        await this.#runInstanceCall(instance, "write", {
            contentBase64: Buffer.from(input.bytes).toString("base64"),
            instanceId: instance.providerInstanceId,
            operation: "write",
            path: input.path,
        });
    }

    async exec(input: ExecHappyComputeHandlerInput, consumerGeneration: string) {
        const instance = await this.#requireReadyInstance(input.instanceId, consumerGeneration);
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
        const existing = this.#stopTasks.get(instanceId);
        if (existing !== undefined) return existing;
        const instance = this.#requireLiveInstance(instanceId, consumerGeneration);
        return this.#beginStop(instance, "stopped at its consumer's request", "stopped");
    }

    close(): Promise<void> {
        return (this.#closeTask ??= this.#close());
    }

    async #close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        clearInterval(this.#reaper);
        const stopTasks = [...this.#instances.values()].map((instance) =>
            this.#beginStop(instance, "Rig daemon shutdown", "stopped"),
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
        instance: Extract<ComputeInstance, { state: "ready" }>,
        operation: T,
        event: ComputeCallPayload<T>,
        deadlineMs = this.#deadline(operation),
    ): Promise<ComputeOperationResult<T>> {
        instance.lastTouchedAt = this.#now();
        try {
            const completion = await this.#invoke(instance.registration, event, deadlineMs);
            if ("error" in completion) throw new PluginComputeError(completion.error);
            this.#recordProviderSuccess(instance.registration);
            return (completion as { result: ComputeOperationResult<T> }).result;
        } catch (error) {
            const tombstone = this.#tombstones.get(instance.id);
            if (tombstone !== undefined) {
                if (error instanceof PluginComputeError && error.code === "provider_lost") {
                    throw computeError(
                        "provider_lost",
                        `${error.message} ${tombstone.reason}`,
                        tombstone.state,
                    );
                }
                throw this.#tombstoneError(tombstone);
            }
            if (error instanceof PluginComputeError && error.code === "not_ready") {
                const unavailable = this.#transitionInstanceUnavailable(instance.id, error.message);
                throw computeError("not_ready", unavailable.reason, "unavailable");
            }
            if (
                error instanceof PluginComputeError &&
                isProviderAttributableCompletionError(error.code) &&
                instance.registration.state.status === "degraded"
            ) {
                const unavailable = this.#transitionInstanceUnavailable(
                    instance.id,
                    `The compute instance is temporarily unavailable. ${error.message}`,
                );
                if (error.code === "deadline_exceeded") {
                    throw computeError("deadline_exceeded", error.message, "unavailable");
                }
                throw computeError("not_ready", unavailable.reason, "unavailable");
            }
            if (error instanceof PluginComputeError && error.state === undefined) {
                throw computeError(error.code, error.message, "ready");
            }
            throw error;
        }
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
                fail(computeError("deadline_exceeded", message));
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

    #requireLiveInstance(instanceId: string, consumerGeneration: string): ComputeInstance {
        const instance = this.#instances.get(instanceId);
        if (instance !== undefined && instance.consumerGeneration === consumerGeneration) {
            return instance;
        }
        const tombstone = this.#tombstones.get(instanceId);
        if (tombstone?.consumerGeneration === consumerGeneration) {
            throw this.#tombstoneError(tombstone);
        }
        throw computeError("instance_not_found", "That compute instance was not found.");
    }

    #requireProvisioningInstance(
        instanceId: string,
        consumerGeneration: string,
    ): Extract<ComputeInstance, { state: "provisioning" }> {
        const instance = this.#instances.get(instanceId);
        if (
            instance?.consumerGeneration === consumerGeneration &&
            instance.state === "provisioning"
        ) {
            return instance;
        }
        throw this.#terminalInstanceError(instanceId, consumerGeneration);
    }

    async #requireReadyInstance(
        instanceId: string,
        consumerGeneration: string,
    ): Promise<Extract<ComputeInstance, { state: "ready" }>> {
        const instance = this.#requireLiveInstance(instanceId, consumerGeneration);
        if (instance.state === "ready") return instance;
        if (instance.state === "unavailable") this.#recoverUnavailableInstance(instance);
        const waitingFor = instance.readiness.promise;
        await waitForReadiness(waitingFor, this.#provisioningGraceMs);
        const current = this.#instances.get(instanceId);
        if (current?.consumerGeneration === consumerGeneration && current.state === "ready") {
            return current;
        }
        const tombstone = this.#tombstones.get(instanceId);
        if (tombstone?.consumerGeneration === consumerGeneration) {
            throw this.#tombstoneError(tombstone);
        }
        if (
            current?.consumerGeneration === consumerGeneration &&
            (current.state === "provisioning" || current.state === "unavailable")
        ) {
            throw computeError(
                "not_ready",
                current.state === "provisioning"
                    ? "The compute instance is still provisioning."
                    : current.reason,
                current.state,
            );
        }
        throw computeError("instance_not_found", "That compute instance was not found.");
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
        for (const instance of this.#instances.values()) {
            if (instance.registration === registration && instance.state === "unavailable") {
                this.#transitionInstanceReady(instance.id);
            }
        }
        if (recovered) this.#notify();
    }

    #recoverUnavailableInstance(
        instance: Extract<ComputeInstance, { state: "unavailable" }>,
    ): void {
        if (this.#recoveryTasks.has(instance.id)) return;
        const deadline = Math.max(
            1,
            Math.min(
                this.#provisioningGraceMs,
                READINESS_PROBE_COMMAND_TIMEOUT_MS + EXEC_DEADLINE_GRACE_MS,
            ),
        );
        const task = this.#invoke(
            instance.registration,
            {
                command: "true",
                instanceId: instance.providerInstanceId,
                operation: "exec",
                timeoutMs: Math.min(READINESS_PROBE_COMMAND_TIMEOUT_MS, deadline),
            },
            deadline,
        )
            .then((completion) => {
                if ("error" in completion) {
                    const current = this.#instances.get(instance.id);
                    if (current?.state === "unavailable") {
                        this.#instances.set(instance.id, {
                            ...current,
                            reason: `The recovery probe failed. ${completion.error.message}`,
                        });
                    }
                    return;
                }
                if (completion.result.exitCode === 0 && !completion.result.timedOut) {
                    this.#recordProviderSuccess(instance.registration);
                    return;
                }
                const reason = completion.result.timedOut
                    ? "The recovery probe timed out."
                    : `The recovery probe exited with code ${String(completion.result.exitCode)}.`;
                this.#recordProviderFailure(instance.registration, reason);
            })
            .catch((error: unknown) => {
                const current = this.#instances.get(instance.id);
                if (current?.state === "unavailable") {
                    this.#instances.set(instance.id, {
                        ...current,
                        reason: `The recovery probe failed. ${errorToMessage(error)}`,
                    });
                }
            })
            .finally(() => this.#recoveryTasks.delete(instance.id));
        this.#recoveryTasks.set(instance.id, task);
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
            for (const instance of this.#instances.values()) {
                if (instance.registration === registration && instance.state === "ready") {
                    this.#transitionInstanceUnavailable(
                        instance.id,
                        `The ${JSON.stringify(instance.provider)} compute provider is degraded. ${reason}`,
                    );
                }
            }
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
            if (instance.registration !== registration) continue;
            this.#terminalizeInstance(
                instance,
                "failed",
                `The ${JSON.stringify(instance.provider)} compute provider crashed or disconnected. ${reason}`,
            );
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
            void this.#beginStop(instance, "its consumer plugin stopped", "stopped");
        }
    }

    #beginStop(
        instance: ComputeInstance,
        reason: string,
        finalState: "failed" | "stopped",
    ): Promise<void> {
        const existing = this.#stopTasks.get(instance.id);
        if (existing !== undefined) return existing;
        const current = this.#instances.get(instance.id);
        if (current === undefined) return Promise.resolve();
        this.#terminalizeInstance(current, finalState, reason);
        const task = this.#finishStop(current, reason).finally(() => {
            this.#stopTasks.delete(current.id);
        });
        this.#stopTasks.set(current.id, task);
        return task;
    }

    async #finishStop(instance: ComputeInstance, reason: string): Promise<void> {
        try {
            if (
                instance.providerInstanceId !== undefined &&
                this.#isCallableRegistration(instance.registration)
            ) {
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
            void this.#beginStop(
                instance,
                `The compute instance died because its ${reason}.`,
                "failed",
            );
        }
    }

    #transitionInstanceReady(instanceId: string): Extract<ComputeInstance, { state: "ready" }> {
        const current = this.#instances.get(instanceId);
        if (current === undefined) {
            throw new Error("The compute instance ended before it became ready.");
        }
        if (current.state === "ready") return current;
        if (current.providerInstanceId === undefined) {
            throw new Error("The compute provider did not materialize the instance.");
        }
        const ready: Extract<ComputeInstance, { state: "ready" }> = {
            consumerGeneration: current.consumerGeneration,
            createdAt: current.createdAt,
            id: current.id,
            lastTouchedAt: this.#now(),
            provider: current.provider,
            providerInstanceId: current.providerInstanceId,
            registration: current.registration,
            state: "ready",
        };
        this.#instances.set(instanceId, ready);
        current.readiness.settle();
        return ready;
    }

    #transitionInstanceUnavailable(
        instanceId: string,
        reason: string,
    ): Extract<ComputeInstance, { state: "unavailable" }> {
        const current = this.#instances.get(instanceId);
        if (current === undefined) {
            throw new Error("The compute instance ended while becoming unavailable.");
        }
        if (current.state === "unavailable") {
            const unavailable = { ...current, reason };
            this.#instances.set(instanceId, unavailable);
            return unavailable;
        }
        if (current.providerInstanceId === undefined) {
            throw new Error("An unmaterialized compute instance cannot become unavailable.");
        }
        const unavailable: Extract<ComputeInstance, { state: "unavailable" }> = {
            ...current,
            providerInstanceId: current.providerInstanceId,
            readiness: createReadinessSignal(),
            reason,
            state: "unavailable",
        };
        this.#instances.set(instanceId, unavailable);
        if (current.state === "provisioning") current.readiness.settle();
        return unavailable;
    }

    #terminalizeInstance(
        instance: ComputeInstance,
        state: "failed" | "stopped",
        reason: string,
    ): ComputeTombstone {
        const current = this.#instances.get(instance.id);
        if (current !== instance) {
            return (
                this.#tombstones.get(instance.id) ?? {
                    consumerGeneration: instance.consumerGeneration,
                    createdAt: instance.createdAt,
                    diedAt: this.#now(),
                    id: instance.id,
                    provider: instance.provider,
                    reason,
                    state,
                }
            );
        }
        this.#instances.delete(instance.id);
        if (instance.state !== "ready") instance.readiness.settle();
        const tombstone: ComputeTombstone = {
            consumerGeneration: instance.consumerGeneration,
            createdAt: instance.createdAt,
            diedAt: this.#now(),
            id: instance.id,
            provider: instance.provider,
            reason,
            state,
        };
        this.#tombstones.set(instance.id, tombstone);
        while (this.#tombstones.size > this.#maxTombstones) {
            const oldest = this.#tombstones.keys().next().value;
            if (oldest === undefined) break;
            this.#tombstones.delete(oldest);
        }
        return tombstone;
    }

    #terminalInstanceError(instanceId: string, consumerGeneration: string): PluginComputeError {
        const tombstone = this.#tombstones.get(instanceId);
        if (tombstone?.consumerGeneration === consumerGeneration) {
            return this.#tombstoneError(tombstone);
        }
        return computeError("instance_not_found", "That compute instance was not found.");
    }

    #tombstoneError(tombstone: ComputeTombstone): PluginComputeError {
        return computeError("instance_failed", tombstone.reason, tombstone.state);
    }

    #toHappyComputeInstance(instance: ComputeInstance | ComputeTombstone): HappyComputeInstance {
        switch (instance.state) {
            case "provisioning":
            case "ready":
                return {
                    createdAt: instance.createdAt,
                    instanceId: instance.id,
                    provider: instance.provider,
                    state: instance.state,
                };
            case "unavailable":
                return {
                    createdAt: instance.createdAt,
                    instanceId: instance.id,
                    provider: instance.provider,
                    reason: instance.reason,
                    state: instance.state,
                };
            case "failed":
            case "stopped":
                return {
                    createdAt: instance.createdAt,
                    diedAt: instance.diedAt,
                    instanceId: instance.id,
                    provider: instance.provider,
                    reason: instance.reason,
                    state: instance.state,
                };
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
    state?: HappyComputeInstanceState,
): PluginComputeError {
    switch (code) {
        case "capacity_exhausted":
        case "deadline_exceeded":
            return new PluginComputeError({
                code,
                message,
                retryable: true,
                ...(state === undefined ? {} : { state }),
            });
        case "not_ready":
            return new PluginComputeError({
                code,
                message,
                retryable: true,
                state: state === "provisioning" || state === "unavailable" ? state : "unavailable",
            });
        case "instance_failed":
        case "instance_not_found":
        case "invalid_request":
        case "invalid_response":
        case "provider_lost":
        case "provider_not_found":
        case "provider_unhealthy":
            return new PluginComputeError({
                code,
                message,
                retryable: false,
                ...(state === undefined ? {} : { state }),
            });
    }
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
        case "not_ready":
        case "provider_lost":
        case "provider_unhealthy":
            return true;
    }
}

function createReadinessSignal(): ReadinessSignal {
    let settle: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        settle = resolve;
    });
    return { promise, settle };
}

function waitForReadiness(readiness: Promise<void>, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
        void readiness.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function remainingDeadline(deadlineAt: number): number {
    return Math.max(1, deadlineAt - Date.now());
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
