import { randomUUID } from "node:crypto";
import type { Context } from "@steve.kite/stdlib";

import { Value } from "@sinclair/typebox/value";
import type {
    HappyNetworkEvent,
    HappyNetworkRequestEvent,
    HappyNetworkRequestCompletion,
    HappyNetworkTunnel,
} from "happy-plugins";
import {
    HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES,
    HAPPY_PLUGIN_MAX_NETWORK_HEADER_BYTES,
    HAPPY_PLUGIN_MAX_NETWORK_HEADER_COUNT,
    HAPPY_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH,
    HAPPY_PLUGIN_MAX_NETWORK_METHOD_LENGTH,
    HAPPY_PLUGIN_MAX_NETWORK_URL_LENGTH,
    happyNetworkRequestCompletionSchema,
    happyNetworkRequestEventSchema,
    happyNetworkTunnelEventSchema,
} from "happy-plugins";

import type {
    ManagedNetworkHttpRequest,
    ManagedNetworkInterceptor,
} from "../agent/context/ManagedNetworkPolicy.js";
import { managedNetworkHttpRequestSchema } from "../agent/context/ManagedNetworkPolicy.js";

const DEFAULT_INTERCEPTION_DEADLINE_MS = 5_000;

interface PendingRequest {
    hostname: string;
    resolve(result: HappyNetworkRequestCompletion): void;
}

interface NetworkRegistration {
    active: boolean;
    id: string;
    pending: Map<string, PendingRequest>;
    send?: (event: HappyNetworkEvent) => boolean;
    type: "request" | "tunnel";
}

interface NetworkOwner {
    closed: boolean;
    domains: ReadonlySet<string>;
    folder: string;
    id: string;
    name: string;
    registrations: Map<string, NetworkRegistration>;
}

export interface PluginNetworkConnection {
    attach(registrationId: string, send: (event: HappyNetworkEvent) => boolean): () => void;
    close(): void;
    complete(
        registrationId: string,
        callId: string,
        completion: HappyNetworkRequestCompletion,
    ): void;
    register(type: "request" | "tunnel"): string;
    unregister(registrationId: string): void;
}

export interface PluginNetworkRegistryOptions {
    deadlineMs?: number;
    onFailure?: (failure: {
        error: string;
        hostname: string;
        pluginFolder: string;
        pluginName: string;
    }) => void;
}

/**
 * Coordinates the reverse socket channel between the managed proxy and running plugins.
 *
 * Domain declarations are selectors only. This registry is called after network policy allows a
 * destination and never participates in reachability decisions.
 */
export class PluginNetworkRegistry implements ManagedNetworkInterceptor {
    readonly #deadlineMs: number;
    readonly #onFailure: PluginNetworkRegistryOptions["onFailure"];
    readonly #owners = new Map<string, NetworkOwner>();
    #closed = false;

    constructor(options: PluginNetworkRegistryOptions = {}) {
        this.#deadlineMs = options.deadlineMs ?? DEFAULT_INTERCEPTION_DEADLINE_MS;
        this.#onFailure = options.onFailure;
    }

    createConnection(plugin: {
        folder: string;
        interceptDomains: readonly string[];
        name: string;
    }): PluginNetworkConnection {
        if (this.#closed) throw new Error("Rig is shutting down, so plugin networking is closed.");
        const owner: NetworkOwner = {
            closed: false,
            domains: new Set(plugin.interceptDomains.map(normalizeDomain)),
            folder: plugin.folder,
            id: randomUUID(),
            name: plugin.name,
            registrations: new Map(),
        };
        this.#owners.set(owner.id, owner);
        const requireOwned = (registrationId: string) => {
            const registration = owner.registrations.get(registrationId);
            if (registration === undefined) {
                throw new Error("That network listener does not belong to this plugin process.");
            }
            return registration;
        };
        return {
            attach: (registrationId, send) => {
                const registration = requireOwned(registrationId);
                if (registration.active) {
                    throw new Error("That plugin network listener is already connected.");
                }
                registration.active = true;
                registration.send = send;
                let attached = true;
                return () => {
                    if (!attached) return;
                    attached = false;
                    this.#retire(owner, registration);
                };
            },
            close: () => {
                if (owner.closed) return;
                owner.closed = true;
                this.#owners.delete(owner.id);
                for (const registration of owner.registrations.values()) {
                    this.#retire(owner, registration);
                }
            },
            complete: (registrationId, callId, completion) => {
                const registration = requireOwned(registrationId);
                if (registration.type !== "request") {
                    throw new Error("Tunnel observations do not accept responses.");
                }
                const decoded = Value.Decode(happyNetworkRequestCompletionSchema, completion);
                const pending = registration.pending.get(callId);
                if (pending === undefined) {
                    throw new Error("That plugin network request is no longer active.");
                }
                registration.pending.delete(callId);
                if (decoded.type === "error") {
                    this.#failure(
                        owner,
                        pending.hostname,
                        `The plugin network handler failed: ${decoded.error}`,
                    );
                    pending.resolve({ type: "pass_through" });
                    return;
                }
                pending.resolve(decoded);
            },
            register: (type) => {
                if (owner.closed || this.#closed) {
                    throw new Error("The plugin process is stopping.");
                }
                if (
                    [...owner.registrations.values()].some(
                        (registration) => registration.type === type,
                    )
                ) {
                    throw new Error(`This plugin already registered a ${type} network listener.`);
                }
                const registration: NetworkRegistration = {
                    active: false,
                    id: randomUUID(),
                    pending: new Map(),
                    type,
                };
                owner.registrations.set(registration.id, registration);
                return registration.id;
            },
            unregister: (registrationId) => {
                this.#retire(owner, requireOwned(registrationId));
            },
        };
    }

    async interceptHttp(
        _ctx: Context,
        request: ManagedNetworkHttpRequest,
    ): Promise<HappyNetworkRequestCompletion> {
        const owners = this.#matchingOwners(request.hostname);
        if (owners.length === 0) return { type: "pass_through" };
        // Folder order is installation identity order. Only the first matching running process may
        // answer; later matches see the same metadata explicitly marked as observation-only.
        const winner = owners[0]!;
        let boundedRequest: ManagedNetworkHttpRequest;
        try {
            boundedRequest = boundRequestMetadata(request);
        } catch (error) {
            this.#failure(winner, request.hostname, errorToMessage(error));
            return { type: "pass_through" };
        }
        for (const owner of owners.slice(1)) {
            const observer = this.#registration(owner, "request");
            try {
                const delivered = observer?.send?.(
                    requestEvent(boundedRequest, randomUUID(), "observe"),
                );
                if (delivered === false) {
                    this.#failure(
                        owner,
                        request.hostname,
                        "The plugin network observer could not accept an event without buffering.",
                    );
                }
            } catch (error) {
                this.#failure(owner, request.hostname, errorToMessage(error));
            }
        }
        const registration = this.#registration(winner, "request");
        const send = registration?.send;
        if (registration === undefined || send === undefined) return { type: "pass_through" };
        const callId = randomUUID();
        return new Promise<HappyNetworkRequestCompletion>((resolve) => {
            let settled = false;
            const finish = (result: HappyNetworkRequestCompletion) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                registration.pending.delete(callId);
                resolve(result);
            };
            const timer = setTimeout(() => {
                this.#failure(
                    winner,
                    request.hostname,
                    "The network handler exceeded its deadline.",
                );
                finish({ type: "pass_through" });
            }, this.#deadlineMs);
            timer.unref();
            registration.pending.set(callId, { hostname: request.hostname, resolve: finish });
            let delivered = false;
            try {
                delivered = send(requestEvent(boundedRequest, callId, "handle"));
            } catch (error) {
                this.#failure(winner, request.hostname, errorToMessage(error));
            }
            if (!delivered) {
                this.#failure(
                    winner,
                    request.hostname,
                    "The plugin network handler could not accept the request without buffering.",
                );
                finish({ type: "pass_through" });
            }
        });
    }

    observeTunnel(tunnel: HappyNetworkTunnel): void {
        const owners = this.#matchingOwners(tunnel.hostname);
        if (owners.length === 0) return;
        let event: HappyNetworkEvent;
        try {
            event = checkedEvent(Value.Decode(happyNetworkTunnelEventSchema, tunnel));
        } catch (error) {
            this.#failure(owners[0]!, tunnel.hostname, errorToMessage(error));
            return;
        }
        for (const owner of owners) {
            try {
                const delivered = this.#registration(owner, "tunnel")?.send?.(event);
                if (delivered === false) {
                    this.#failure(
                        owner,
                        tunnel.hostname,
                        "The plugin tunnel observer could not accept an event without buffering.",
                    );
                }
            } catch (error) {
                this.#failure(owner, tunnel.hostname, errorToMessage(error));
            }
        }
    }

    recordFailure(hostname: string, error: unknown): void {
        const owners = this.#matchingOwners(hostname);
        const owner =
            owners.find((candidate) => this.#registration(candidate, "request") !== undefined) ??
            owners[0];
        if (owner !== undefined) this.#failure(owner, hostname, errorToMessage(error));
    }

    shouldIntercept(hostname: string): boolean {
        return this.#matchingOwners(hostname).some(
            (owner) => this.#registration(owner, "request")?.send !== undefined,
        );
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const owner of this.#owners.values()) {
            owner.closed = true;
            for (const registration of owner.registrations.values()) {
                this.#retire(owner, registration);
            }
        }
        this.#owners.clear();
    }

    #matchingOwners(hostname: string): NetworkOwner[] {
        const normalized = normalizeDomain(hostname);
        return [...this.#owners.values()]
            .filter((owner) => !owner.closed && owner.domains.has(normalized))
            .sort((left, right) =>
                left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0,
            );
    }

    #registration(
        owner: NetworkOwner,
        type: NetworkRegistration["type"],
    ): NetworkRegistration | undefined {
        return [...owner.registrations.values()].find(
            (registration) => registration.active && registration.type === type,
        );
    }

    #retire(owner: NetworkOwner, registration: NetworkRegistration): void {
        if (owner.registrations.get(registration.id) !== registration) return;
        owner.registrations.delete(registration.id);
        registration.active = false;
        delete registration.send;
        for (const pending of registration.pending.values()) {
            pending.resolve({ type: "pass_through" });
        }
        registration.pending.clear();
    }

    #failure(owner: NetworkOwner, hostname: string, error: string): void {
        try {
            this.#onFailure?.({
                error,
                hostname,
                pluginFolder: owner.folder,
                pluginName: owner.name,
            });
        } catch {
            // Logging never replaces the normal network path.
        }
    }
}

function normalizeDomain(value: string): string {
    return value.trim().toLowerCase().replace(/\.$/u, "");
}

function requestEvent(
    request: ManagedNetworkHttpRequest,
    callId: string,
    mode: "handle" | "observe",
): HappyNetworkRequestEvent {
    return checkedEvent(
        Value.Decode(happyNetworkRequestEventSchema, {
            bodyBase64: Buffer.from(request.body).toString("base64"),
            callId,
            headers: request.headers,
            hostname: request.hostname,
            method: request.method,
            mode,
            type: "request",
            url: request.url,
        }),
    );
}

function boundRequestMetadata(request: ManagedNetworkHttpRequest): ManagedNetworkHttpRequest {
    return Value.Decode(managedNetworkHttpRequestSchema, {
        body: Buffer.from(request.body),
        headers: boundHeaders(request.headers),
        hostname: request.hostname.slice(0, 253),
        method: request.method.slice(0, HAPPY_PLUGIN_MAX_NETWORK_METHOD_LENGTH),
        url: request.url.slice(0, HAPPY_PLUGIN_MAX_NETWORK_URL_LENGTH),
    });
}

function boundHeaders(
    headers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    let bytes = 2;
    let count = 0;
    for (const [name, value] of Object.entries(headers)) {
        if (
            count >= HAPPY_PLUGIN_MAX_NETWORK_HEADER_COUNT ||
            name.length === 0 ||
            name.length > 256
        ) {
            continue;
        }
        const boundedValue =
            typeof value === "string"
                ? value.slice(0, HAPPY_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH)
                : value
                      .slice(0, 32)
                      .map((item) => item.slice(0, HAPPY_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH));
        const entryBytes = Buffer.byteLength(JSON.stringify({ [name]: boundedValue })) - 2;
        const separatorBytes = count === 0 ? 0 : 1;
        if (bytes + separatorBytes + entryBytes > HAPPY_PLUGIN_MAX_NETWORK_HEADER_BYTES) continue;
        result[name] = boundedValue;
        bytes += separatorBytes + entryBytes;
        count += 1;
    }
    return result;
}

function checkedEvent<TEvent extends HappyNetworkEvent>(event: TEvent): TEvent {
    if (Buffer.byteLength(`${JSON.stringify(event)}\n`) > HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES) {
        throw new Error("The bounded plugin network event is too large.");
    }
    return event;
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
