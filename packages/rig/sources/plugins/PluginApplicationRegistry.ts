import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import type {
    HappyPluginApplicationActionCompletion,
    HappyPluginApplicationContribution,
    HappyPluginApplicationEvent,
    HappyPluginApplicationRegistration,
    HappyPluginResourceMediaType,
} from "happy-plugins";
import {
    HAPPY_PLUGIN_MAX_APPLICATIONS,
    HAPPY_PLUGIN_MAX_APPLICATION_RESOURCE_BYTES,
    HAPPY_PLUGIN_MAX_RESOURCE_BYTES,
    happyPluginApplicationActionCompletionSchema,
    happyPluginApplicationRegistrationSchema,
    happyPluginResourcePathSchema,
} from "happy-plugins";

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const MAXIMUM_PENDING_ACTIONS_PER_APPLICATION = 64;

interface PendingApplicationAction {
    cleanup(): void;
    reject(error: Error): void;
    resolve(result: unknown): void;
}

interface ApplicationOwner {
    folder: string;
    generation: string;
    name: string;
}

interface ApplicationResource {
    body: Buffer;
    mediaType: HappyPluginResourceMediaType;
    path: string;
}

interface ApplicationRegistration {
    active: boolean;
    application: HappyPluginApplicationRegistration;
    id: string;
    owner: ApplicationOwner;
    pendingActions: Map<string, PendingApplicationAction>;
    resources: ReadonlyMap<string, ApplicationResource>;
    send?: (event: HappyPluginApplicationEvent) => void;
}

export interface PluginApplicationConnection {
    attach(registrationId: string, send: (event: HappyPluginApplicationEvent) => void): () => void;
    close(): void;
    complete(
        registrationId: string,
        requestId: string,
        completion: HappyPluginApplicationActionCompletion,
    ): void;
    register(application: HappyPluginApplicationRegistration): {
        generation: string;
        registrationId: string;
    };
    unregister(registrationId: string): void;
}

export interface PluginApplicationResource {
    body: Buffer;
    mediaType: HappyPluginResourceMediaType;
}

/** The stable application identity does not exist in this running catalog. */
export class PluginApplicationNotFoundError extends Error {
    constructor(message = "That plugin application is not available.") {
        super(message);
        this.name = "PluginApplicationNotFoundError";
    }
}

/** A view addressed an application process that has already been replaced or stopped. */
export class PluginApplicationStaleGenerationError extends Error {
    constructor() {
        super("That plugin application generation is no longer available.");
        this.name = "PluginApplicationStaleGenerationError";
    }
}

/** The plugin handled an application action and returned a bounded failure. */
export class PluginApplicationActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginApplicationActionError";
    }
}

/**
 * Daemon-wide applications owned by running plugin process generations.
 *
 * Registrations become visible only after their action stream attaches. Every resource is copied
 * into bounded daemon memory, and owner teardown synchronously removes contributions and rejects
 * pending actions before replacement code can register under the same stable identity.
 */
export class PluginApplicationRegistry {
    readonly #actionTimeoutMs: number;
    readonly #listeners = new Set<() => void>();
    readonly #registrations = new Map<string, ApplicationRegistration>();
    #closed = false;

    constructor(options: { actionTimeoutMs?: number } = {}) {
        this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    }

    createConnection(plugin: { folder: string; name: string }): PluginApplicationConnection {
        if (this.#closed) {
            throw new Error("Rig is shutting down, so plugin applications are unavailable.");
        }
        const owner: ApplicationOwner = {
            ...plugin,
            generation: randomUUID(),
        };
        let ownerClosed = false;
        const owned = () =>
            [...this.#registrations.values()].filter(
                (registration) => registration.owner === owner,
            );
        const requireOwned = (registrationId: string): ApplicationRegistration => {
            const registration = this.#registrations.get(registrationId);
            if (registration?.owner !== owner) {
                throw new Error(
                    "That application registration does not belong to this plugin process.",
                );
            }
            return registration;
        };

        return {
            attach: (registrationId, send) => {
                const registration = requireOwned(registrationId);
                if (registration.active) {
                    throw new Error("That plugin application is already connected.");
                }
                registration.active = true;
                registration.send = send;
                this.#publishChanged();
                let attached = true;
                return () => {
                    if (!attached) return;
                    attached = false;
                    this.#retire(registration, "The plugin application connection closed.");
                };
            },
            close: () => {
                if (ownerClosed) return;
                ownerClosed = true;
                for (const registration of owned()) {
                    this.#retire(registration, "The plugin process stopped.");
                }
            },
            complete: (registrationId, requestId, completion) => {
                const registration = requireOwned(registrationId);
                Value.Assert(happyPluginApplicationActionCompletionSchema, completion);
                const action = registration.pendingActions.get(requestId);
                if (action === undefined) {
                    throw new Error("That plugin application action is no longer active.");
                }
                registration.pendingActions.delete(requestId);
                action.cleanup();
                if ("error" in completion) {
                    action.reject(new PluginApplicationActionError(completion.error));
                } else {
                    action.resolve(completion.result);
                }
            },
            register: (application) => {
                if (ownerClosed || this.#closed) {
                    throw new Error(
                        "The plugin process is stopping, so it cannot register applications.",
                    );
                }
                if (owned().length >= HAPPY_PLUGIN_MAX_APPLICATIONS) {
                    throw new Error(
                        `A plugin can register at most ${String(HAPPY_PLUGIN_MAX_APPLICATIONS)} applications.`,
                    );
                }
                const decoded = Value.Decode(happyPluginApplicationRegistrationSchema, application);
                const stableId = applicationIdentity(owner.folder, decoded.id);
                if (
                    [...this.#registrations.values()].some(
                        (registration) => contributionIdentity(registration) === stableId,
                    )
                ) {
                    throw new Error(
                        `The plugin application identity "${decoded.id}" is already registered.`,
                    );
                }
                const resources = decodeResources(decoded);
                const id = randomUUID();
                this.#registrations.set(id, {
                    active: false,
                    application: decoded,
                    id,
                    owner,
                    pendingActions: new Map(),
                    resources,
                });
                return { generation: owner.generation, registrationId: id };
            },
            unregister: (registrationId) => {
                this.#retire(
                    requireOwned(registrationId),
                    "The plugin unregistered this application.",
                );
            },
        };
    }

    list(folder?: string): readonly HappyPluginApplicationContribution[] {
        return [...this.#registrations.values()]
            .filter(
                (registration) =>
                    registration.active &&
                    (folder === undefined || registration.owner.folder === folder),
            )
            .map(toContribution)
            .sort(compareContributions);
    }

    readResource(
        applicationId: string,
        generation: string,
        resourcePath: string,
    ): PluginApplicationResource {
        if (!Value.Check(happyPluginResourcePathSchema, resourcePath)) {
            throw new PluginApplicationNotFoundError(
                "That plugin application resource path is invalid.",
            );
        }
        const registration = this.#find(applicationId, generation);
        const resource = registration.resources.get(resourcePath);
        if (resource === undefined) {
            throw new PluginApplicationNotFoundError(
                "That plugin application resource does not exist.",
            );
        }
        return { body: resource.body, mediaType: resource.mediaType };
    }

    invoke(
        applicationId: string,
        generation: string,
        actionName: string,
        input: unknown,
        signal?: AbortSignal,
    ): Promise<unknown> {
        let registration: ApplicationRegistration;
        try {
            registration = this.#find(applicationId, generation);
        } catch (error) {
            return Promise.reject(error);
        }
        if (!registration.application.actions.includes(actionName)) {
            return Promise.reject(
                new PluginApplicationNotFoundError(
                    "That plugin application action does not exist.",
                ),
            );
        }
        const send = registration.send;
        if (send === undefined) {
            return Promise.reject(
                new PluginApplicationNotFoundError("That plugin application is disconnected."),
            );
        }
        if (registration.pendingActions.size >= MAXIMUM_PENDING_ACTIONS_PER_APPLICATION) {
            return Promise.reject(
                new PluginApplicationActionError(
                    `That plugin application already has ${String(MAXIMUM_PENDING_ACTIONS_PER_APPLICATION)} actions in progress.`,
                ),
            );
        }
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", cancel);
            };
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                registration.pendingActions.delete(requestId);
                finish();
                reject(error);
            };
            const cancel = () => {
                trySend(registration, { requestId, type: "cancel" });
                fail(
                    new PluginApplicationActionError(
                        "The plugin application action was cancelled.",
                    ),
                );
            };
            const timer = setTimeout(() => {
                trySend(registration, { requestId, type: "cancel" });
                fail(
                    new PluginApplicationActionError(
                        `The plugin application action timed out after ${String(this.#actionTimeoutMs)}ms.`,
                    ),
                );
            }, this.#actionTimeoutMs);
            timer.unref();
            registration.pendingActions.set(requestId, {
                cleanup: finish,
                reject: fail,
                resolve: (result) => {
                    if (settled) return;
                    settled = true;
                    finish();
                    resolve(result);
                },
            });
            if (signal?.aborted === true) {
                cancel();
                return;
            }
            signal?.addEventListener("abort", cancel, { once: true });
            try {
                send({
                    action: actionName,
                    input,
                    requestId,
                    type: "request",
                });
            } catch {
                fail(
                    new PluginApplicationActionError(
                        "The plugin disconnected before receiving the application action.",
                    ),
                );
            }
        });
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const registration of [...this.#registrations.values()]) {
            this.#retire(registration, "Rig shut down the plugin application catalog.");
        }
        this.#listeners.clear();
    }

    #find(applicationId: string, generation: string): ApplicationRegistration {
        const registrations = [...this.#registrations.values()].filter(
            (registration) =>
                registration.active && contributionIdentity(registration) === applicationId,
        );
        const current = registrations.find(
            (registration) => registration.owner.generation === generation,
        );
        if (current !== undefined) return current;
        if (registrations.length > 0) throw new PluginApplicationStaleGenerationError();
        throw new PluginApplicationNotFoundError();
    }

    #publishChanged(): void {
        for (const listener of this.#listeners) {
            try {
                listener();
            } catch {
                // Lifecycle cleanup cannot be held hostage by a catalog observer.
            }
        }
    }

    #retire(registration: ApplicationRegistration, reason: string): void {
        if (this.#registrations.get(registration.id) !== registration) return;
        this.#registrations.delete(registration.id);
        const wasActive = registration.active;
        registration.active = false;
        delete registration.send;
        for (const action of registration.pendingActions.values()) {
            action.cleanup();
            action.reject(new PluginApplicationActionError(reason));
        }
        registration.pendingActions.clear();
        if (wasActive) this.#publishChanged();
    }
}

function trySend(registration: ApplicationRegistration, event: HappyPluginApplicationEvent): void {
    try {
        registration.send?.(event);
    } catch {
        // Cancellation is best effort after a stream has already closed.
    }
}

function applicationIdentity(folder: string, applicationId: string): string {
    return `${folder}:${applicationId}`;
}

function contributionIdentity(registration: ApplicationRegistration): string {
    return applicationIdentity(registration.owner.folder, registration.application.id);
}

function toContribution(registration: ApplicationRegistration): HappyPluginApplicationContribution {
    return {
        actions: registration.application.actions,
        applicationId: registration.application.id,
        entry: registration.application.entry,
        generation: registration.owner.generation,
        id: contributionIdentity(registration),
        navigation: registration.application.navigation,
        pluginFolder: registration.owner.folder,
        resources: [...registration.resources.values()]
            .map((resource) => ({
                mediaType: resource.mediaType,
                path: resource.path,
                size: resource.body.byteLength,
            }))
            .sort((left, right) => compareText(left.path, right.path)),
        title: registration.application.title,
    };
}

function compareContributions(
    left: HappyPluginApplicationContribution,
    right: HappyPluginApplicationContribution,
): number {
    return (
        left.navigation.order - right.navigation.order ||
        compareText(left.navigation.label, right.navigation.label) ||
        compareText(left.pluginFolder, right.pluginFolder) ||
        compareText(left.applicationId, right.applicationId)
    );
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function decodeResources(
    application: HappyPluginApplicationRegistration,
): ReadonlyMap<string, ApplicationResource> {
    const resources = new Map<string, ApplicationResource>();
    let totalBytes = 0;
    for (const resource of application.resources) {
        if (resources.has(resource.path)) {
            throw new Error(`The application has more than one resource at "${resource.path}".`);
        }
        const body = decodeResourceBody(resource);
        if (body.byteLength > HAPPY_PLUGIN_MAX_RESOURCE_BYTES) {
            throw new Error(
                `The application resource "${resource.path}" is larger than ${String(HAPPY_PLUGIN_MAX_RESOURCE_BYTES)} bytes.`,
            );
        }
        totalBytes += body.byteLength;
        resources.set(resource.path, {
            body,
            mediaType: resource.mediaType,
            path: resource.path,
        });
    }
    if (totalBytes > HAPPY_PLUGIN_MAX_APPLICATION_RESOURCE_BYTES) {
        throw new Error(
            `Application resources total more than ${String(HAPPY_PLUGIN_MAX_APPLICATION_RESOURCE_BYTES)} bytes.`,
        );
    }
    const entry = resources.get(application.entry);
    if (entry?.mediaType !== "text/html") {
        throw new Error("The application entry must name one registered HTML resource.");
    }
    const icon = application.navigation.icon;
    if (icon !== undefined && !resources.get(icon)?.mediaType.startsWith("image/")) {
        throw new Error("The application navigation icon must name a registered image resource.");
    }
    return resources;
}

function decodeResourceBody(
    resource: HappyPluginApplicationRegistration["resources"][number],
): Buffer {
    if (resource.encoding === "utf8") return Buffer.from(resource.body, "utf8");
    const body = Buffer.from(resource.body, "base64");
    const normalized = resource.body.replace(/=+$/u, "");
    if (body.toString("base64").replace(/=+$/u, "") !== normalized) {
        throw new Error(`The application resource "${resource.path}" is not valid base64.`);
    }
    return body;
}
