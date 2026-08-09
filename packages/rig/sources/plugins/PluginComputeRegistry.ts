import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
    HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
    HAPPY_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS,
    HAPPY_COMPUTE_MAX_PROVISIONING_TIMEOUT_MS,
    HAPPY_COMPUTE_PROVISIONING_ACK_TIMEOUT_MS,
    type CreateHappyComputeInput,
    type ExecHappyComputeHandlerInput,
    type HappyComputeError,
    type HappyComputeErrorCode,
    type HappyComputeInstance,
    type HappyComputeInstanceState,
    type HappyComputePreparationPhase,
    type HappyComputeProvisioningProgress,
    type HappyComputeProvider,
    type HappyComputeProviderManifest,
    type HappyComputeWorkspaceSource,
    type ReadHappyComputeInput,
    type WriteHappyComputeInput,
    type RegisterHappyComputeProviderInput,
} from "happy-plugins";
import {
    happyComputeCallCompletionSchema,
    happyComputeProvisioningProgressSchema,
    normalizeHappyComputeError,
    registerHappyComputeProviderInputSchema,
    type HappyComputeCallCompletion,
    type HappyComputeEvent,
} from "happy-plugins/internal";
import { formatComputeDuration } from "./formatComputeDuration.js";

const DEFAULT_OPERATION_DEADLINE_MS = 10_000;
const EXEC_DEADLINE_GRACE_MS = 2_000;
const MAX_ACTIVE_COMPUTE_INSTANCES = 256;
const MAX_PENDING_COMPUTE_CALLS = 256;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const MAX_RETAINED_COMPUTE_TOMBSTONES = 256;
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
    acknowledgment:
        | { status: "acknowledged" }
        | { status: "awaiting_acknowledgment" }
        | { status: "not_required" };
    acknowledge(): void;
    cleanup(): void;
    operation: ComputeOperation;
    progress?: (progress: HappyComputeProvisioningProgress) => void;
    reject(error: PluginComputeError): void;
    resolve(completion: HappyComputeCallCompletion): void;
};

type ComputeInvokeOptions = {
    acknowledgmentDeadlineMs?: number;
    deadlineAttribution?: "provider" | "provisioning";
    progress?: (progress: HappyComputeProvisioningProgress) => void;
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
    provisioningTimeoutMs: number;
    state: ComputeProviderState;
};

type ComputeInstanceBase = {
    consumerGeneration: string;
    createdAt: number;
    id: string;
    provider: string;
    workspaceSource: HappyComputeWorkspaceSource;
};

type ComputePreparationTelemetry = {
    elapsedMs: number;
    lastProgressAt: number;
    percent?: number;
    phase: HappyComputePreparationPhase;
    startedAt: number;
};

type ComputeInstance =
    | (ComputeInstanceBase & {
          reason?: string;
          state: "unprovisioned";
      })
    | (ComputeInstanceBase & {
          attemptId: string;
          lastProgressAt: number;
          message: string;
          percent?: number;
          phase: HappyComputePreparationPhase;
          providerInstanceId?: string;
          registration?: ComputeRegistration;
          startedAt: number;
          state: "provisioning";
      })
    | (ComputeInstanceBase & {
          activatedAt: number;
          lastTouchedAt: number;
          preparation: ComputePreparationTelemetry;
          providerInstanceId: string;
          registration: ComputeRegistration;
          state: "ready";
      })
    | (ComputeInstanceBase & {
          activatedAt: number;
          lastTouchedAt: number;
          preparation: ComputePreparationTelemetry;
          providerInstanceId: string;
          registration: ComputeRegistration;
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
    workspaceSource: HappyComputeWorkspaceSource;
};

export type PluginComputePreparationPhase = HappyComputePreparationPhase;

export type PluginComputeRegistryEvent =
    | { type: "catalog_changed" }
    | {
          consumerGeneration: string;
          createdAt: number;
          elapsedMs?: number;
          error?: HappyComputeError;
          instanceId: string;
          lastProgressAt?: number;
          message: string;
          percent?: number;
          phase: PluginComputePreparationPhase;
          provider: string;
          startedAt?: number;
          state: "failed" | "provisioning" | "ready" | "stopped" | "unavailable" | "unprovisioned";
          type: "preparation";
          workspaceSource: HappyComputeWorkspaceSource;
      };

export interface PluginComputeConnection {
    readonly generation: string;
    attach(registrationId: string, send: (event: HappyComputeEvent) => boolean): () => void;
    acknowledge(registrationId: string, callId: string): void;
    assertReady(): void;
    close(): void;
    complete(registrationId: string, callId: string, completion: unknown): void;
    progress(registrationId: string, callId: string, progress: unknown): void;
    register(input?: RegisterHappyComputeProviderInput): string;
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
    readonly elapsedMs: number | undefined;
    readonly lastProgressAt: number | undefined;
    readonly percent: number | undefined;
    readonly phase: string | undefined;
    readonly retryable: boolean;
    readonly startedAt: number | undefined;
    readonly state: HappyComputeInstanceState | undefined;

    constructor(error: HappyComputeError) {
        super(error.message);
        this.name = "PluginComputeError";
        this.code = error.code;
        this.elapsedMs = error.code === "preparing_compute" ? error.elapsedMs : undefined;
        this.lastProgressAt = error.code === "preparing_compute" ? error.lastProgressAt : undefined;
        this.percent = error.code === "preparing_compute" ? error.percent : undefined;
        this.phase = error.code === "preparing_compute" ? error.phase : undefined;
        this.retryable = error.retryable;
        this.startedAt = error.code === "preparing_compute" ? error.startedAt : undefined;
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
    /** Lowers the start acknowledgment deadline. Intended for deterministic tests. */
    provisionAcknowledgementTimeoutMs?: number;
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
    readonly #listeners = new Set<(event: PluginComputeRegistryEvent) => unknown>();
    readonly #presentationOverrides = new Map<string, ComputeInstance | ComputeTombstone>();
    readonly #log: NonNullable<PluginComputeRegistryOptions["log"]>;
    readonly #maxInstances: number;
    readonly #maxLifetimeMs: number;
    readonly #maxTombstones: number;
    readonly #now: () => number;
    readonly #provisionAcknowledgementTimeoutMs: number;
    readonly #registrations = new Map<string, ComputeRegistration>();
    readonly #recoveryTasks = new Map<string, Promise<void>>();
    readonly #reaper: NodeJS.Timeout;
    readonly #stopTasks = new Map<string, Promise<void>>();
    readonly #tombstones = new Map<string, ComputeTombstone>();
    #closeTask: Promise<void> | undefined;
    #closed = false;

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
        this.#provisionAcknowledgementTimeoutMs = Math.min(
            options.provisionAcknowledgementTimeoutMs ?? HAPPY_COMPUTE_PROVISIONING_ACK_TIMEOUT_MS,
            HAPPY_COMPUTE_PROVISIONING_ACK_TIMEOUT_MS,
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
            acknowledge: (registrationId, callId) => {
                const registration = requireOwned(registrationId);
                const call = registration.pendingCalls.get(callId);
                if (call === undefined || call.operation !== "start") {
                    throw computeError(
                        "invalid_request",
                        "That compute provisioning call is no longer awaiting acknowledgment.",
                    );
                }
                call.acknowledge();
            },
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
                this.#notifyCatalog();
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
                call.acknowledge();
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
            progress: (registrationId, callId, progress) => {
                const registration = requireOwned(registrationId);
                const call = registration.pendingCalls.get(callId);
                if (call === undefined) {
                    throw computeError(
                        "invalid_request",
                        "That plugin compute call is no longer active.",
                    );
                }
                try {
                    call.acknowledge();
                    const decoded = Value.Decode(happyComputeProvisioningProgressSchema, progress);
                    if (call.operation !== "start" || call.progress === undefined) {
                        throw new Error(
                            "The plugin reported provisioning progress for a call that is not provisioning compute.",
                        );
                    }
                    call.progress(decoded);
                } catch (error) {
                    const failure = `The compute provider returned invalid provisioning progress. ${errorToMessage(error)}`;
                    this.#recordProviderFailure(registration, failure);
                    if (registration.pendingCalls.get(callId) === call) {
                        registration.pendingCalls.delete(callId);
                        call.cleanup();
                        call.reject(computeError("invalid_response", failure));
                    }
                    throw computeError("invalid_response", failure);
                }
            },
            register: (input = {}) => {
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
                const registrationInput = Value.Decode(
                    registerHappyComputeProviderInputSchema,
                    input,
                );
                const id = randomUUID();
                const provisioningTimeoutMs = Math.min(
                    registrationInput.provisioningTimeoutMs ??
                        HAPPY_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS,
                    HAPPY_COMPUTE_MAX_PROVISIONING_TIMEOUT_MS,
                );
                this.#registrations.set(id, {
                    id,
                    ...(options.onRequiredRegistrationRetired === undefined
                        ? {}
                        : {
                              onRequiredRegistrationRetired: options.onRequiredRegistrationRetired,
                          }),
                    owner,
                    pendingCalls: new Map(),
                    provisioningTimeoutMs,
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
                        provisioningTimeoutMs: registration.provisioningTimeoutMs,
                    },
                ];
            })
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    listInstances(consumerGeneration: string): readonly HappyComputeInstance[] {
        return [
            ...[...this.#instances.values()]
                .filter((instance) => instance.consumerGeneration === consumerGeneration)
                .map((instance) =>
                    this.#toHappyComputeInstance(
                        this.#presentationOverrides.get(instance.id) ?? instance,
                    ),
                ),
            ...[...this.#tombstones.values()]
                .filter((tombstone) => tombstone.consumerGeneration === consumerGeneration)
                .map((tombstone) =>
                    this.#toHappyComputeInstance(
                        this.#presentationOverrides.get(tombstone.id) ?? tombstone,
                    ),
                ),
        ].sort(
            (left, right) =>
                left.createdAt - right.createdAt || left.instanceId.localeCompare(right.instanceId),
        );
    }

    subscribe(listener: (event: PluginComputeRegistryEvent) => unknown): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    create(input: CreateHappyComputeInput, consumerGeneration: string): HappyComputeInstance {
        if (!this.#consumerGenerations.has(consumerGeneration)) {
            throw computeError(
                "provider_lost",
                "The compute consumer generation is no longer active.",
            );
        }
        if (this.#instances.size >= this.#maxInstances) {
            throw computeError(
                "capacity_exhausted",
                `Rig can keep at most ${String(this.#maxInstances)} compute instance handles active.`,
            );
        }
        const instance: Extract<ComputeInstance, { state: "unprovisioned" }> = {
            consumerGeneration,
            createdAt: this.#now(),
            id: randomUUID(),
            provider: input.provider,
            state: "unprovisioned",
            workspaceSource: input.workspaceSource,
        };
        this.#instances.set(instance.id, instance);
        return this.#toHappyComputeInstance(instance);
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
        return this.#beginStop(instance, "The consumer requested it.", "stopped");
    }

    close(): Promise<void> {
        return (this.#closeTask ??= this.#close());
    }

    async #close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        clearInterval(this.#reaper);
        const stopTasks = [...this.#instances.values()].map((instance) =>
            this.#beginStop(instance, "Rig shut down.", "stopped"),
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
            if (error instanceof PluginComputeError && error.code === "preparing_compute") {
                const unavailable = this.#transitionInstanceUnavailable(instance.id, error.message);
                throw computeError("preparing_compute", unavailable.reason, "unavailable");
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
                throw computeError("preparing_compute", unavailable.reason, "unavailable");
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
        options: ComputeInvokeOptions = {},
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
            let acknowledgmentTimer: NodeJS.Timeout | undefined;
            let deadlineTimer: NodeJS.Timeout | undefined;
            const finish = () => {
                if (acknowledgmentTimer !== undefined) clearTimeout(acknowledgmentTimer);
                if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
            };
            const fail = (error: PluginComputeError) => {
                if (settled) return;
                settled = true;
                registration.pendingCalls.delete(callId);
                finish();
                reject(error);
            };
            const call: PendingComputeCall = {
                acknowledgment:
                    options.acknowledgmentDeadlineMs === undefined
                        ? { status: "not_required" }
                        : { status: "awaiting_acknowledgment" },
                acknowledge: () => {
                    if (call.acknowledgment.status !== "awaiting_acknowledgment") return;
                    if (acknowledgmentTimer !== undefined) clearTimeout(acknowledgmentTimer);
                    acknowledgmentTimer = undefined;
                    call.acknowledgment = { status: "acknowledged" };
                },
                cleanup: finish,
                operation: event.operation,
                ...(options.progress === undefined ? {} : { progress: options.progress }),
                reject: fail,
                resolve: (completion) => {
                    if (settled) return;
                    settled = true;
                    finish();
                    resolve(completion as ComputeOperationCompletion<T>);
                },
            };
            deadlineTimer = setTimeout(() => {
                const message =
                    options.deadlineAttribution === "provisioning"
                        ? `Compute provisioning exceeded its ${formatComputeDuration(deadlineMs)} overall budget while running ${event.operation}.`
                        : `The compute provider missed its ${event.operation} deadline after ${formatComputeDuration(deadlineMs)}.`;
                const state = registration.state;
                if (state.status === "healthy" || state.status === "degraded") {
                    try {
                        state.send({ callId, type: "cancel" });
                    } catch {
                        // The deadline remains the useful failure if cancellation cannot be sent.
                    }
                }
                if (options.deadlineAttribution !== "provisioning") {
                    this.#recordProviderFailure(registration, message);
                }
                fail(computeError("deadline_exceeded", message));
            }, deadlineMs);
            deadlineTimer.unref();
            const acknowledgmentDeadlineMs = options.acknowledgmentDeadlineMs;
            if (acknowledgmentDeadlineMs !== undefined) {
                acknowledgmentTimer = setTimeout(() => {
                    const message = `The compute provider did not acknowledge provisioning within ${formatComputeDuration(acknowledgmentDeadlineMs)}.`;
                    const state = registration.state;
                    if (state.status === "healthy" || state.status === "degraded") {
                        try {
                            state.send({ callId, type: "cancel" });
                        } catch {
                            // The missed acknowledgment remains the useful failure.
                        }
                    }
                    this.#recordProviderFailure(registration, message);
                    fail(computeError("deadline_exceeded", message));
                }, acknowledgmentDeadlineMs);
                acknowledgmentTimer.unref();
            }
            registration.pendingCalls.set(callId, call);
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

    #requireReadyInstance(
        instanceId: string,
        consumerGeneration: string,
    ): Extract<ComputeInstance, { state: "ready" }> {
        const instance = this.#requireLiveInstance(instanceId, consumerGeneration);
        switch (instance.state) {
            case "ready":
                return instance;
            case "unprovisioned": {
                const provisioning = this.#beginProvisioning(instance);
                throw this.#preparingError(provisioning);
            }
            case "provisioning":
                throw this.#preparingError(instance);
            case "unavailable":
                this.#recoverUnavailableInstance(instance);
                throw computeError("preparing_compute", instance.reason, "unavailable");
        }
    }

    #preparingError(
        instance: Extract<ComputeInstance, { state: "provisioning" }>,
    ): PluginComputeError {
        const elapsedMs = Math.max(0, this.#now() - instance.startedAt);
        return new PluginComputeError({
            code: "preparing_compute",
            elapsedMs,
            lastProgressAt: instance.lastProgressAt,
            message: instance.message,
            ...(instance.percent === undefined ? {} : { percent: instance.percent }),
            phase: instance.phase,
            retryable: true,
            startedAt: instance.startedAt,
            state: "provisioning",
        });
    }

    #beginProvisioning(
        instance: Extract<ComputeInstance, { state: "unprovisioned" }>,
    ): Extract<ComputeInstance, { state: "provisioning" }> {
        const message =
            instance.reason === undefined
                ? "Preparing compute for its first use."
                : `Preparing compute again. The previous attempt failed: ${instance.reason}`;
        const startedAt = this.#now();
        const provisioning: Extract<ComputeInstance, { state: "provisioning" }> = {
            attemptId: randomUUID(),
            consumerGeneration: instance.consumerGeneration,
            createdAt: instance.createdAt,
            id: instance.id,
            lastProgressAt: startedAt,
            message,
            phase: "preparing_compute",
            provider: instance.provider,
            state: "provisioning",
            startedAt,
            workspaceSource: instance.workspaceSource,
        };
        this.#instances.set(instance.id, provisioning);
        const published = this.#emitPreparation(
            provisioning,
            "preparing_compute",
            message,
            "provisioning",
        );
        queueMicrotask(() => {
            void this.#provisionInstance(provisioning.id, provisioning.attemptId, published);
        });
        return provisioning;
    }

    async #provisionInstance(
        instanceId: string,
        attemptId: string,
        initialPublication: Promise<void>,
    ): Promise<void> {
        await initialPublication;
        let registration: ComputeRegistration | undefined;
        try {
            let current = this.#currentProvisioning(instanceId, attemptId);
            if (current === undefined) return;
            registration = this.#findCallableRegistration(current.provider);
            if (registration === undefined) {
                throw computeError(
                    "provider_not_found",
                    `No running compute provider is named "${current.provider}".`,
                );
            }
            current = { ...current, registration };
            this.#instances.set(instanceId, current);
            const deadlineAt = Date.now() + registration.provisioningTimeoutMs;
            const completion = await this.#invoke(
                registration,
                {
                    operation: "start",
                    workspaceSource: current.workspaceSource,
                },
                remainingDeadline(deadlineAt),
                {
                    acknowledgmentDeadlineMs: this.#provisionAcknowledgementTimeoutMs,
                    deadlineAttribution: "provisioning",
                    progress: (progress) =>
                        this.#reportProviderProgress(instanceId, attemptId, progress),
                },
            );
            if ("error" in completion) {
                throw new PluginComputeError(
                    completion.error.code === "preparing_compute"
                        ? {
                              code: "invalid_response",
                              message:
                                  "The provider reported preparing_compute instead of completing its provisioning call.",
                              retryable: false,
                          }
                        : completion.error,
                );
            }
            const providerInstanceId = completion.result.instanceId;
            current = this.#currentProvisioning(instanceId, attemptId);
            if (current === undefined) {
                this.#stopProviderInstanceBestEffort(
                    registration,
                    providerInstanceId,
                    "retired provisioning",
                );
                return;
            }
            const duplicate = [...this.#instances.values()].some(
                (candidate) =>
                    candidate !== current &&
                    candidate.state !== "unprovisioned" &&
                    candidate.registration === registration &&
                    candidate.providerInstanceId === providerInstanceId,
            );
            if (duplicate) {
                const message =
                    "The compute provider returned an instance ID that is already active.";
                this.#recordProviderFailure(registration, message);
                this.#stopProviderInstanceBestEffort(
                    registration,
                    providerInstanceId,
                    "duplicate provider instance",
                );
                throw computeError("invalid_response", message);
            }
            current = {
                ...current,
                providerInstanceId,
                registration,
            };
            this.#instances.set(instanceId, current);
            this.#recordProviderSuccess(registration);
            if (
                !this.#isCallableRegistration(registration) ||
                !this.#consumerGenerations.has(current.consumerGeneration)
            ) {
                this.#stopProviderInstanceBestEffort(
                    registration,
                    providerInstanceId,
                    "retired provisioning",
                );
                throw computeError(
                    "provider_lost",
                    "The compute provider or consumer generation retired while provisioning the instance.",
                );
            }
            this.#updatePreparation(
                current,
                "verifying_compute",
                "Verifying that the compute is ready.",
            );
            const probe = await this.#invoke(
                registration,
                {
                    command: "true",
                    instanceId: providerInstanceId,
                    operation: "exec",
                    timeoutMs: Math.min(
                        READINESS_PROBE_COMMAND_TIMEOUT_MS,
                        remainingDeadline(deadlineAt),
                    ),
                },
                remainingDeadline(deadlineAt),
                { deadlineAttribution: "provisioning" },
            );
            if ("error" in probe) throw new PluginComputeError(probe.error);
            if (probe.result.exitCode !== 0 || probe.result.timedOut) {
                const reason = probe.result.timedOut
                    ? "The compute readiness probe timed out."
                    : `The compute readiness probe exited with code ${String(probe.result.exitCode)}.`;
                this.#recordProviderFailure(registration, reason);
                throw computeError(
                    probe.result.timedOut ? "deadline_exceeded" : "invalid_response",
                    reason,
                );
            }
            this.#recordProviderSuccess(registration);
            current = this.#currentProvisioning(instanceId, attemptId);
            if (current === undefined) return;
            const ready = this.#transitionInstanceReady(current);
            this.#emitPreparation(ready, "ready", "Compute is ready.", "ready");
        } catch (error) {
            const current = this.#currentProvisioning(instanceId, attemptId);
            if (current === undefined) return;
            if (
                current.providerInstanceId !== undefined &&
                current.registration !== undefined &&
                this.#isCallableRegistration(current.registration)
            ) {
                this.#stopProviderInstanceBestEffort(
                    current.registration,
                    current.providerInstanceId,
                    "failed provisioning",
                );
            }
            this.#failProvisioningAttempt(
                current,
                `Compute provisioning failed. ${errorToMessage(error)}`,
            );
        }
    }

    #currentProvisioning(
        instanceId: string,
        attemptId: string,
    ): Extract<ComputeInstance, { state: "provisioning" }> | undefined {
        const current = this.#instances.get(instanceId);
        return current?.state === "provisioning" && current.attemptId === attemptId
            ? current
            : undefined;
    }

    #findCallableRegistration(provider: string): ComputeRegistration | undefined {
        return [...this.#registrations.values()].find(
            (candidate) =>
                this.#isCallableRegistration(candidate) &&
                candidate.owner.compute?.name.toLowerCase() === provider.toLowerCase(),
        );
    }

    #reportProviderProgress(
        instanceId: string,
        attemptId: string,
        progress: HappyComputeProvisioningProgress,
    ): void {
        const current = this.#currentProvisioning(instanceId, attemptId);
        if (current === undefined) return;
        this.#updatePreparation(current, progress.phase, progress.message, progress.percent);
    }

    #updatePreparation(
        instance: Extract<ComputeInstance, { state: "provisioning" }>,
        phase: PluginComputePreparationPhase,
        message: string,
        percent?: number,
    ): void {
        if (this.#instances.get(instance.id) !== instance) return;
        const { percent: _previousPercent, ...withoutPercent } = instance;
        const next = {
            ...withoutPercent,
            lastProgressAt: this.#now(),
            message,
            ...(percent === undefined ? {} : { percent }),
            phase,
        };
        this.#instances.set(instance.id, next);
        this.#emitPreparation(next, phase, message, "provisioning");
    }

    #failProvisioningAttempt(
        instance: Extract<ComputeInstance, { state: "provisioning" }>,
        reason: string,
    ): void {
        if (this.#instances.get(instance.id) !== instance) return;
        const unprovisioned: Extract<ComputeInstance, { state: "unprovisioned" }> = {
            consumerGeneration: instance.consumerGeneration,
            createdAt: instance.createdAt,
            id: instance.id,
            provider: instance.provider,
            reason,
            state: "unprovisioned",
            workspaceSource: instance.workspaceSource,
        };
        this.#presentationOverrides.set(instance.id, instance);
        this.#instances.set(instance.id, unprovisioned);
        this.#emitPreparation(instance, "failed", reason, "unprovisioned", {
            code: "preparing_compute",
            message: reason,
            retryable: true,
            state: "unprovisioned",
        });
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
            if (instance.state === "unavailable" && instance.registration === registration) {
                const ready = this.#transitionInstanceReady(instance);
                this.#emitPreparation(ready, "ready", "Compute is ready.", "ready");
            }
        }
        if (recovered) this.#notifyCatalog();
    }

    #recoverUnavailableInstance(
        instance: Extract<ComputeInstance, { state: "unavailable" }>,
    ): void {
        if (this.#recoveryTasks.has(instance.id)) return;
        const deadline = READINESS_PROBE_COMMAND_TIMEOUT_MS + EXEC_DEADLINE_GRACE_MS;
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
                if (instance.state === "ready" && instance.registration === registration) {
                    this.#transitionInstanceUnavailable(
                        instance.id,
                        `The ${JSON.stringify(instance.provider)} compute provider is degraded. ${reason}`,
                    );
                }
            }
            this.#notifyCatalog();
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
            if (instance.state === "unprovisioned" || instance.registration !== registration) {
                continue;
            }
            const failure = `The ${JSON.stringify(instance.provider)} compute provider crashed or disconnected. ${reason}`;
            if (instance.state === "provisioning" && instance.providerInstanceId === undefined) {
                this.#failProvisioningAttempt(instance, failure);
                continue;
            }
            this.#terminalizeInstance(instance, "failed", failure);
        }
        for (const call of registration.pendingCalls.values()) {
            call.cleanup();
            call.reject(computeError("provider_lost", `The compute provider was lost. ${reason}`));
        }
        registration.pendingCalls.clear();
        this.#notifyCatalog();
    }

    #removeRegistration(registration: ComputeRegistration): void {
        if (this.#registrations.get(registration.id) !== registration) return;
        this.#registrations.delete(registration.id);
        this.#notifyCatalog();
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
            void this.#beginStop(instance, "Its consumer plugin stopped.", "stopped");
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
        const registration = instance.state === "unprovisioned" ? undefined : instance.registration;
        const providerInstanceId =
            instance.state === "unprovisioned" ? undefined : instance.providerInstanceId;
        try {
            if (
                providerInstanceId !== undefined &&
                registration !== undefined &&
                this.#isCallableRegistration(registration)
            ) {
                const completion = await this.#invoke(
                    registration,
                    {
                        instanceId: providerInstanceId,
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
                            provider: instance.provider,
                            reason,
                            error: completion.error.message,
                        },
                    );
                } else {
                    this.#recordProviderSuccess(registration);
                }
            }
        } catch (error) {
            this.#log(
                "warning",
                "plugin_compute_cleanup_failed",
                "A compute provider could not stop an instance.",
                {
                    instanceId: instance.id,
                    provider: instance.provider,
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
            if (instance.state === "provisioning") continue;
            if (instance.state === "unprovisioned") {
                const lifetime = now - instance.createdAt;
                if (lifetime < this.#maxLifetimeMs) continue;
                const reason = `maximum unprovisioned lifetime of ${formatComputeDuration(this.#maxLifetimeMs)} expired`;
                this.#log(
                    "info",
                    "plugin_compute_instance_reaped",
                    "Rig automatically stopped an expired compute instance.",
                    {
                        instanceId: instance.id,
                        lifetimeMs: lifetime,
                        provider: instance.provider,
                        reason,
                    },
                );
                void this.#beginStop(instance, `Its ${reason}.`, "failed");
                continue;
            }
            const lifetime = now - instance.activatedAt;
            const idle = now - instance.lastTouchedAt;
            const reason =
                lifetime >= this.#maxLifetimeMs
                    ? `maximum lifetime of ${formatComputeDuration(this.#maxLifetimeMs)} expired`
                    : idle >= this.#idleTimeoutMs
                      ? `idle timeout of ${formatComputeDuration(this.#idleTimeoutMs)} expired`
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
                    provider: instance.provider,
                    reason,
                },
            );
            void this.#beginStop(instance, `Its ${reason}.`, "failed");
        }
    }

    #transitionInstanceReady(
        current: Extract<ComputeInstance, { state: "provisioning" | "unavailable" }>,
    ): Extract<ComputeInstance, { state: "ready" }> {
        if (this.#instances.get(current.id) !== current) {
            throw new Error("The compute instance ended before it became ready.");
        }
        if (current.providerInstanceId === undefined || current.registration === undefined) {
            throw new Error("The compute provider did not materialize the instance.");
        }
        const now = this.#now();
        const preparation =
            current.state === "provisioning"
                ? {
                      elapsedMs: Math.max(0, now - current.startedAt),
                      lastProgressAt: current.lastProgressAt,
                      phase: current.phase,
                      startedAt: current.startedAt,
                  }
                : current.preparation;
        const ready: Extract<ComputeInstance, { state: "ready" }> = {
            activatedAt: current.state === "unavailable" ? current.activatedAt : now,
            consumerGeneration: current.consumerGeneration,
            createdAt: current.createdAt,
            id: current.id,
            lastTouchedAt: now,
            preparation,
            provider: current.provider,
            providerInstanceId: current.providerInstanceId,
            registration: current.registration,
            state: "ready",
            workspaceSource: current.workspaceSource,
        };
        this.#presentationOverrides.set(current.id, current);
        this.#instances.set(current.id, ready);
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
        if (current.state !== "ready") {
            throw new Error("Only a ready compute instance can become unavailable.");
        }
        const unavailable: Extract<ComputeInstance, { state: "unavailable" }> = {
            ...current,
            reason,
            state: "unavailable",
        };
        this.#instances.set(instanceId, unavailable);
        this.#emitPreparation(unavailable, "preparing_compute", reason, "unavailable", {
            code: "preparing_compute",
            message: reason,
            retryable: true,
            state: "unavailable",
        });
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
                    workspaceSource: instance.workspaceSource,
                }
            );
        }
        this.#instances.delete(instance.id);
        const tombstone: ComputeTombstone = {
            consumerGeneration: instance.consumerGeneration,
            createdAt: instance.createdAt,
            diedAt: this.#now(),
            id: instance.id,
            provider: instance.provider,
            reason,
            state,
            workspaceSource: instance.workspaceSource,
        };
        this.#presentationOverrides.set(instance.id, instance);
        this.#tombstones.set(instance.id, tombstone);
        while (this.#tombstones.size > this.#maxTombstones) {
            const oldest = this.#tombstones.keys().next().value;
            if (oldest === undefined) break;
            this.#tombstones.delete(oldest);
        }
        const lifecycle =
            instance.state === "unprovisioned" || instance.state === "provisioning"
                ? "preparation"
                : "instance";
        const message =
            state === "failed"
                ? `Compute ${lifecycle} failed. ${reason}`
                : `Compute ${lifecycle} stopped. ${reason}`;
        this.#emitPreparation(
            instance,
            state === "failed" ? "failed" : "stopped",
            message,
            state,
            state === "failed"
                ? {
                      code: "instance_failed",
                      message,
                      retryable: false,
                      state: "failed",
                  }
                : undefined,
        );
        return tombstone;
    }

    #tombstoneError(tombstone: ComputeTombstone): PluginComputeError {
        return computeError("instance_failed", tombstone.reason, tombstone.state);
    }

    #toHappyComputeInstance(instance: ComputeInstance | ComputeTombstone): HappyComputeInstance {
        switch (instance.state) {
            case "unprovisioned":
                return {
                    createdAt: instance.createdAt,
                    instanceId: instance.id,
                    provider: instance.provider,
                    ...(instance.reason === undefined ? {} : { reason: instance.reason }),
                    state: instance.state,
                };
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
        if (operation === "exec") {
            return (
                (commandTimeoutMs ?? HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS) +
                EXEC_DEADLINE_GRACE_MS
            );
        }
        return DEFAULT_OPERATION_DEADLINE_MS;
    }

    #notifyCatalog(): void {
        this.#emit({ type: "catalog_changed" });
    }

    #emitPreparation(
        instance: ComputeInstance | ComputeTombstone,
        phase: PluginComputePreparationPhase,
        message: string,
        state: "failed" | "provisioning" | "ready" | "stopped" | "unavailable" | "unprovisioned",
        error?: HappyComputeError,
    ): Promise<void> {
        const telemetry =
            instance.state === "provisioning"
                ? {
                      elapsedMs: Math.max(0, this.#now() - instance.startedAt),
                      lastProgressAt: instance.lastProgressAt,
                      ...(instance.percent === undefined ? {} : { percent: instance.percent }),
                      phase: instance.phase,
                      startedAt: instance.startedAt,
                  }
                : instance.state === "ready" || instance.state === "unavailable"
                  ? instance.preparation
                  : undefined;
        const preparation =
            telemetry === undefined
                ? {}
                : {
                      elapsedMs: telemetry.elapsedMs,
                      lastProgressAt: telemetry.lastProgressAt,
                      ...(state !== "provisioning" || telemetry.percent === undefined
                          ? {}
                          : { percent: telemetry.percent }),
                      startedAt: telemetry.startedAt,
                  };
        const classifiedError =
            error?.code === "preparing_compute" && telemetry !== undefined
                ? {
                      ...error,
                      ...preparation,
                      phase: telemetry.phase,
                  }
                : error;
        return this.#emit({
            consumerGeneration: instance.consumerGeneration,
            createdAt: this.#now(),
            ...preparation,
            ...(classifiedError === undefined ? {} : { error: classifiedError }),
            instanceId: instance.id,
            message,
            phase,
            provider: instance.provider,
            state,
            type: "preparation",
            workspaceSource: instance.workspaceSource,
        });
    }

    #emit(event: PluginComputeRegistryEvent): Promise<void> {
        const deliveries: Promise<void>[] = [];
        for (const listener of this.#listeners) {
            try {
                const delivery = listener(event);
                deliveries.push(Promise.resolve(delivery).then(() => undefined));
            } catch {
                // One event consumer cannot interrupt compute lifecycle transitions.
            }
        }
        if (event.type !== "preparation") {
            return Promise.resolve();
        }
        const override = this.#presentationOverrides.get(event.instanceId);
        if (deliveries.length === 0) {
            if (override !== undefined) {
                this.#presentationOverrides.delete(event.instanceId);
            }
            return Promise.resolve();
        }
        return Promise.allSettled(deliveries).then(() => {
            if (override === undefined) return;
            if (this.#presentationOverrides.get(event.instanceId) === override) {
                this.#presentationOverrides.delete(event.instanceId);
            }
        });
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
        case "preparing_compute":
            return new PluginComputeError({
                code,
                message,
                retryable: true,
                state:
                    state === "unprovisioned" || state === "provisioning" || state === "unavailable"
                        ? state
                        : "provisioning",
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
        case "preparing_compute":
        case "provider_lost":
        case "provider_unhealthy":
            return true;
    }
}

function remainingDeadline(deadlineAt: number): number {
    return Math.max(1, deadlineAt - Date.now());
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
