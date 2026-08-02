import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
    HAPPY_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
    type ExecHappyComputeHandlerInput,
    type HappyComputeErrorCode,
    type HappyComputeProvider,
    type HappyComputeProviderManifest,
    type ReadHappyComputeInput,
    type StartHappyComputeInput,
    type WriteHappyComputeInput,
} from "happy-plugins";
import {
    happyComputeCallCompletionSchema,
    type HappyComputeCallCompletion,
    type HappyComputeEvent,
} from "happy-plugins/internal";

const DEFAULT_OPERATION_DEADLINE_MS = 10_000;
const DEFAULT_START_DEADLINE_MS = 30_000;
const EXEC_DEADLINE_GRACE_MS = 2_000;
const MAX_ACTIVE_COMPUTE_INSTANCES = 256;
const MAX_PENDING_COMPUTE_CALLS = 256;
const MAX_RETAINED_FAILED_INSTANCES = 1_024;

type ComputeOperation = "exec" | "read" | "start" | "stop" | "write";
type ComputeCallEvent = Extract<HappyComputeEvent, { type: "call" }>;
type WithoutComputeCallEnvelope<T> = T extends ComputeCallEvent
    ? Omit<T, "callId" | "type">
    : never;
type ComputeCallPayload<T extends ComputeOperation> = Extract<
    WithoutComputeCallEnvelope<ComputeCallEvent>,
    { operation: T }
>;
type ComputeErrorCompletion = Extract<HappyComputeCallCompletion, { error: string }>;
type ComputeOperationCompletion<T extends ComputeOperation> =
    | ComputeErrorCompletion
    | Extract<HappyComputeCallCompletion, { operation: T }>;
type ComputeOperationResult<T extends ComputeOperation> =
    Extract<HappyComputeCallCompletion, { operation: T }> extends { result: infer TResult }
        ? TResult
        : never;

interface PendingComputeCall {
    cleanup(): void;
    operation: ComputeOperation;
    reject(error: Error): void;
    resolve(completion: HappyComputeCallCompletion): void;
}

interface ComputeOwner {
    compute?: HappyComputeProviderManifest;
    folder: string;
    generation: string;
    name: string;
}

interface ComputeRegistration {
    active: boolean;
    id: string;
    owner: ComputeOwner;
    pendingCalls: Map<string, PendingComputeCall>;
    send?: (event: HappyComputeEvent) => boolean;
}

interface ComputeInstance {
    consumerGeneration: string;
    createdOrder: number;
    failure?: string;
    failureCode?: "failed" | "stale_generation";
    id: string;
    providerInstanceId: string;
    registration: ComputeRegistration;
    state: "active" | "failed";
}

export interface PluginComputeConnection {
    readonly generation: string;
    attach(registrationId: string, send: (event: HappyComputeEvent) => boolean): () => void;
    assertReady(): void;
    close(): void;
    complete(registrationId: string, callId: string, completion: HappyComputeCallCompletion): void;
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
    constructor(
        readonly code: HappyComputeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "PluginComputeError";
    }
}

export interface PluginComputeRegistryOptions {
    /** Overrides every operation deadline. Intended for deterministic tests. */
    callTimeoutMs?: number;
}

/**
 * Daemon-wide compute catalog and the terminal lifecycle of every public compute instance.
 *
 * Public instance IDs map to provider-private IDs and a single plugin process generation. Stream
 * loss retires that generation synchronously; later provider processes cannot accidentally accept
 * calls addressed to an old instance.
 */
export class PluginComputeRegistry {
    readonly #callTimeoutMs: number | undefined;
    readonly #consumerGenerations = new Set<string>();
    readonly #instances = new Map<string, ComputeInstance>();
    readonly #listeners = new Set<() => void>();
    readonly #registrations = new Map<string, ComputeRegistration>();
    #closed = false;
    #nextInstanceOrder = 1;
    #reservedInstanceSlots = 0;

    constructor(options: PluginComputeRegistryOptions = {}) {
        this.#callTimeoutMs = options.callTimeoutMs;
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
                throw new PluginComputeError(
                    "registration_conflict",
                    "That compute registration does not belong to this plugin process.",
                );
            }
            return registration;
        };
        return {
            generation: owner.generation,
            attach: (registrationId, send) => {
                const registration = requireOwned(registrationId);
                if (registration.active) {
                    throw new PluginComputeError(
                        "registration_conflict",
                        "That plugin compute registration is already connected.",
                    );
                }
                registration.active = true;
                registration.send = send;
                this.#notify();
                let attached = true;
                return () => {
                    if (!attached) return;
                    attached = false;
                    this.#retire(
                        registration,
                        {
                            reason: "The plugin compute connection closed.",
                            status: "failed",
                        },
                        options.onRequiredRegistrationRetired,
                    );
                };
            },
            assertReady: () => {
                if (owner.compute === undefined) return;
                if (!owned().some((registration) => registration.active)) {
                    throw new PluginComputeError(
                        "registration_conflict",
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
                    this.#retire(
                        registration,
                        {
                            reason: "The compute provider plugin stopped.",
                            status: "failed",
                        },
                        options.onRequiredRegistrationRetired,
                    );
                }
            },
            complete: (registrationId, callId, completion) => {
                const registration = requireOwned(registrationId);
                const decoded = Value.Decode(happyComputeCallCompletionSchema, completion);
                const call = registration.pendingCalls.get(callId);
                if (call === undefined) {
                    throw new PluginComputeError(
                        "registration_conflict",
                        "That plugin compute call is no longer active.",
                    );
                }
                if ("operation" in decoded && decoded.operation !== call.operation) {
                    throw new PluginComputeError(
                        "registration_conflict",
                        `The plugin completed a ${call.operation} compute call with a ${decoded.operation} result.`,
                    );
                }
                registration.pendingCalls.delete(callId);
                call.cleanup();
                call.resolve(decoded);
            },
            register: () => {
                if (ownerClosed || this.#closed) {
                    throw new PluginComputeError(
                        "registration_conflict",
                        "The plugin process is stopping, so it cannot register compute.",
                    );
                }
                if (owner.compute === undefined) {
                    throw new PluginComputeError(
                        "registration_conflict",
                        "This plugin did not declare a compute provider in happy.plugin.json.",
                    );
                }
                if (owned().length > 0) {
                    throw new PluginComputeError(
                        "registration_conflict",
                        "This plugin process already registered its compute provider.",
                    );
                }
                const key = owner.compute.name.toLowerCase();
                if (
                    [...this.#registrations.values()].some(
                        (registration) => registration.owner.compute?.name.toLowerCase() === key,
                    )
                ) {
                    throw new PluginComputeError(
                        "registration_conflict",
                        `A compute provider named "${owner.compute.name}" is already registered.`,
                    );
                }
                const id = randomUUID();
                this.#registrations.set(id, {
                    active: false,
                    id,
                    owner,
                    pendingCalls: new Map(),
                });
                return id;
            },
            unregister: (registrationId) => {
                this.#retire(
                    requireOwned(registrationId),
                    {
                        reason: "The plugin unregistered its compute provider.",
                        status: "stopped",
                    },
                    options.onRequiredRegistrationRetired,
                );
            },
        };
    }

    list(): readonly HappyComputeProvider[] {
        return this.#activeRegistrations()
            .map((registration) => ({
                name: registration.owner.compute!.name,
                pluginFolder: registration.owner.folder,
                pluginName: registration.owner.name,
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async start(input: StartHappyComputeInput, consumerGeneration: string) {
        if (!this.#consumerGenerations.has(consumerGeneration)) {
            throw new PluginComputeError(
                "stale_generation",
                "The compute consumer generation is no longer active.",
            );
        }
        const registration = this.#activeRegistrations().find(
            (candidate) =>
                candidate.owner.compute?.name.toLowerCase() === input.provider.toLowerCase(),
        );
        if (registration === undefined) {
            throw new PluginComputeError(
                "provider_not_found",
                `No running compute provider is named "${input.provider}".`,
            );
        }
        if (
            this.#activeInstanceCount() + this.#reservedInstanceSlots >=
            MAX_ACTIVE_COMPUTE_INSTANCES
        ) {
            throw new PluginComputeError(
                "provider_failed",
                `Rig can keep at most ${String(MAX_ACTIVE_COMPUTE_INSTANCES)} compute instances active.`,
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
            if ("error" in completion) {
                throw new PluginComputeError("operation_failed", completion.error);
            }
            if (
                !this.#isActiveRegistration(registration) ||
                !this.#consumerGenerations.has(consumerGeneration)
            ) {
                this.#stopProviderInstanceBestEffort(registration, completion.result.instanceId);
                throw new PluginComputeError(
                    "stale_generation",
                    "The compute provider or consumer generation retired while it was starting the instance.",
                );
            }
            const duplicate = [...this.#instances.values()].some(
                (instance) =>
                    instance.state === "active" &&
                    instance.registration === registration &&
                    instance.providerInstanceId === completion.result.instanceId,
            );
            if (duplicate) {
                this.#stopProviderInstanceBestEffort(registration, completion.result.instanceId);
                throw new PluginComputeError(
                    "provider_failed",
                    "The compute provider returned an instance ID that is already active.",
                );
            }
            const id = randomUUID();
            this.#instances.set(id, {
                consumerGeneration,
                createdOrder: this.#nextInstanceOrder++,
                id,
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
        const instance = this.#requireActiveInstance(input.instanceId, consumerGeneration);
        return this.#runInstanceCall(instance, "read", {
            instanceId: instance.providerInstanceId,
            operation: "read",
            path: input.path,
        });
    }

    async write(input: WriteHappyComputeInput, consumerGeneration: string): Promise<void> {
        const instance = this.#requireActiveInstance(input.instanceId, consumerGeneration);
        await this.#runInstanceCall(instance, "write", {
            contentBase64: Buffer.from(input.bytes).toString("base64"),
            instanceId: instance.providerInstanceId,
            operation: "write",
            path: input.path,
        });
    }

    async exec(input: ExecHappyComputeHandlerInput, consumerGeneration: string) {
        const instance = this.#requireActiveInstance(input.instanceId, consumerGeneration);
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

    async stop(instanceId: string, consumerGeneration: string): Promise<void> {
        const instance = this.#requireOwnedInstance(instanceId, consumerGeneration);
        try {
            if (this.#isActiveRegistration(instance.registration)) {
                const completion = await this.#invoke(
                    instance.registration,
                    {
                        instanceId: instance.providerInstanceId,
                        operation: "stop",
                    },
                    this.#deadline("stop"),
                );
                if ("error" in completion) {
                    throw new PluginComputeError("operation_failed", completion.error);
                }
            }
        } finally {
            // Stop is also the release operation. Provider cleanup is attempted even after an
            // instance fails, while the public ID and bounded registry slot are always released.
            this.#instances.delete(instance.id);
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const registration of [...this.#registrations.values()]) {
            this.#retire(registration, {
                reason: "Rig shut down the plugin compute catalog.",
                status: "failed",
            });
        }
        this.#consumerGenerations.clear();
        this.#instances.clear();
        this.#listeners.clear();
    }

    async #runInstanceCall<T extends Exclude<ComputeOperation, "start">>(
        instance: ComputeInstance,
        operation: T,
        event: ComputeCallPayload<T>,
        deadlineMs = this.#deadline(operation),
    ): Promise<ComputeOperationResult<T>> {
        let completion: ComputeOperationCompletion<T>;
        try {
            completion = await this.#invoke(instance.registration, event, deadlineMs);
        } catch (error) {
            if (
                instance.state === "active" &&
                error instanceof PluginComputeError &&
                (error.code === "deadline_missed" || error.code === "stale_generation")
            ) {
                this.#failInstance(
                    instance,
                    error.code === "deadline_missed" ? "failed" : "stale_generation",
                    error.message,
                );
            }
            throw error;
        }
        if ("error" in completion) {
            throw new PluginComputeError("operation_failed", completion.error);
        }
        return (completion as { result: ComputeOperationResult<T> }).result;
    }

    #invoke<T extends ComputeOperation>(
        registration: ComputeRegistration,
        event: ComputeCallPayload<T>,
        deadlineMs: number,
    ): Promise<ComputeOperationCompletion<T>> {
        if (!registration.active || registration.send === undefined) {
            return Promise.reject(
                new PluginComputeError(
                    "stale_generation",
                    "The compute provider generation is no longer connected.",
                ),
            );
        }
        if (registration.pendingCalls.size >= MAX_PENDING_COMPUTE_CALLS) {
            return Promise.reject(
                new PluginComputeError(
                    "provider_failed",
                    `A compute provider can have at most ${String(MAX_PENDING_COMPUTE_CALLS)} calls in flight.`,
                ),
            );
        }
        const callId = randomUUID();
        return new Promise<ComputeOperationCompletion<T>>((resolve, reject) => {
            let settled = false;
            const finish = () => clearTimeout(timer);
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                registration.pendingCalls.delete(callId);
                finish();
                reject(error);
            };
            const timer = setTimeout(() => {
                const message = `The compute provider missed its ${event.operation} deadline after ${String(deadlineMs)}ms.`;
                const error = new PluginComputeError("deadline_missed", message);
                registration.send?.({ callId, type: "cancel" });
                fail(error);
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
            if (
                registration.send?.({
                    ...event,
                    callId,
                    type: "call",
                } as HappyComputeEvent) !== true
            ) {
                fail(
                    new PluginComputeError(
                        "stale_generation",
                        "The compute provider disconnected before receiving the call.",
                    ),
                );
            }
        });
    }

    #requireOwnedInstance(instanceId: string, consumerGeneration: string): ComputeInstance {
        const instance = this.#instances.get(instanceId);
        if (instance === undefined || instance.consumerGeneration !== consumerGeneration) {
            throw new PluginComputeError(
                "instance_not_found",
                "That compute instance was not found.",
            );
        }
        return instance;
    }

    #requireActiveInstance(instanceId: string, consumerGeneration: string): ComputeInstance {
        const instance = this.#requireOwnedInstance(instanceId, consumerGeneration);
        if (instance.state === "failed") {
            throw new PluginComputeError(
                instance.failureCode === "stale_generation"
                    ? "stale_generation"
                    : "instance_failed",
                instance.failure ?? "That compute instance is in a terminal failed state.",
            );
        }
        return instance;
    }

    #retire(
        registration: ComputeRegistration,
        retirement: PluginComputeRegistrationRetirement,
        onRequiredRegistrationRetired?: (retirement: PluginComputeRegistrationRetirement) => void,
    ): void {
        if (this.#registrations.get(registration.id) !== registration) return;
        const wasActive = registration.active;
        this.#registrations.delete(registration.id);
        registration.active = false;
        delete registration.send;
        this.#failRegistrationInstances(registration, "stale_generation", retirement.reason);
        for (const call of registration.pendingCalls.values()) {
            call.cleanup();
            call.reject(new PluginComputeError("stale_generation", retirement.reason));
        }
        registration.pendingCalls.clear();
        if (wasActive && registration.owner.compute !== undefined) {
            onRequiredRegistrationRetired?.(retirement);
        }
        this.#notify();
    }

    #failInstance(
        instance: ComputeInstance,
        code: "failed" | "stale_generation",
        failure: string,
    ): void {
        instance.state = "failed";
        instance.failureCode = code;
        instance.failure = failure;
        const failed = [...this.#instances.values()]
            .filter((candidate) => candidate.state === "failed")
            .sort((left, right) => left.createdOrder - right.createdOrder);
        while (failed.length > MAX_RETAINED_FAILED_INSTANCES) {
            const evicted = failed.shift();
            if (evicted !== undefined) this.#instances.delete(evicted.id);
        }
    }

    #failRegistrationInstances(
        registration: ComputeRegistration,
        code: "failed" | "stale_generation",
        failure: string,
    ): void {
        for (const instance of this.#instances.values()) {
            if (instance.registration === registration && instance.state === "active") {
                this.#failInstance(instance, code, failure);
            }
        }
    }

    #activeRegistrations(): ComputeRegistration[] {
        return [...this.#registrations.values()].filter(
            (registration) => registration.active && registration.owner.compute !== undefined,
        );
    }

    #isActiveRegistration(registration: ComputeRegistration): boolean {
        return (
            this.#registrations.get(registration.id) === registration &&
            registration.active &&
            registration.send !== undefined
        );
    }

    #releaseConsumerInstances(consumerGeneration: string): void {
        for (const instance of [...this.#instances.values()]) {
            if (instance.consumerGeneration !== consumerGeneration) continue;
            this.#instances.delete(instance.id);
            this.#stopProviderInstanceBestEffort(
                instance.registration,
                instance.providerInstanceId,
            );
        }
    }

    #stopProviderInstanceBestEffort(
        registration: ComputeRegistration,
        providerInstanceId: string,
    ): void {
        if (!this.#isActiveRegistration(registration)) return;
        void this.#invoke(
            registration,
            { instanceId: providerInstanceId, operation: "stop" },
            this.#deadline("stop"),
        ).catch(() => undefined);
    }

    #activeInstanceCount(): number {
        return [...this.#instances.values()].filter((instance) => instance.state === "active")
            .length;
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
