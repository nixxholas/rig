import { randomUUID } from "node:crypto";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
    HappyMcpCallCompletion,
    HappyMcpEvent,
    HappyMcpServerRegistration,
    HappyMcpToolResult,
} from "happy-plugins";
import {
    createHappyMcpToolName,
    happyMcpCallCompletionSchema,
    happyMcpCompletionToResult,
    happyMcpServerRegistrationSchema,
    normalizeHappyMcpName,
} from "happy-plugins";

import { defineTool, type AnyDefinedTool } from "../agent/types.js";
import { describeMcpAutoPermissionAction } from "../mcp/describeMcpAutoPermissionAction.js";
import { humanizeMcpName } from "../mcp/humanizeMcpName.js";
import { isMcpErrorResult } from "../mcp/isMcpErrorResult.js";
import { mcpResultToContentBlocks } from "../mcp/mcpResultToContentBlocks.js";
import type { McpServerSummary, McpToolLoadResult, McpToolProvider } from "../mcp/types.js";
import type { PermissionMode } from "../permissions/index.js";

const DEFAULT_PLUGIN_MCP_CALL_TIMEOUT_MS = 30_000;
const MAXIMUM_SERVERS_PER_PLUGIN = 16;
const RESTRICTED_REASON =
    "Plugin MCP tools are available in Auto or Full access because plugins can act outside Rig's sandbox.";

interface PendingPluginMcpCall {
    cleanup(): void;
    reject(error: Error): void;
    resolve(result: HappyMcpToolResult): void;
}

interface PluginMcpRegistration {
    active: boolean;
    id: string;
    owner: PluginMcpOwner;
    pendingCalls: Map<string, PendingPluginMcpCall>;
    send?: (event: HappyMcpEvent) => boolean;
    server: HappyMcpServerRegistration;
}

interface PluginMcpOwner {
    folder: string;
    id: string;
    name: string;
}

export interface PluginMcpConnection {
    attach(registrationId: string, send: (event: HappyMcpEvent) => boolean): () => void;
    close(): void;
    complete(registrationId: string, callId: string, completion: HappyMcpCallCompletion): void;
    register(server: HappyMcpServerRegistration): string;
    unregister(registrationId: string): void;
}

export interface PluginMcpRegistryOptions {
    callTimeoutMs?: number;
}

/**
 * The daemon-wide live catalog of MCP servers owned by plugin process generations.
 *
 * Registrations become visible only after the SDK's event stream is attached. Retiring an owner
 * rejects its pending calls synchronously, so a result from an old process can never land after a
 * restart or replacement.
 */
export class PluginMcpRegistry implements McpToolProvider {
    readonly #callTimeoutMs: number;
    readonly #registrations = new Map<string, PluginMcpRegistration>();
    #closed = false;

    constructor(options: PluginMcpRegistryOptions = {}) {
        this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_PLUGIN_MCP_CALL_TIMEOUT_MS;
    }

    createConnection(plugin: { folder: string; name: string }): PluginMcpConnection {
        if (this.#closed) throw new Error("Rig is shutting down, so plugin MCP is unavailable.");
        const owner: PluginMcpOwner = { ...plugin, id: randomUUID() };
        let ownerClosed = false;
        const owned = () =>
            [...this.#registrations.values()].filter(
                (registration) => registration.owner.id === owner.id,
            );
        const requireOwned = (registrationId: string): PluginMcpRegistration => {
            const registration = this.#registrations.get(registrationId);
            if (registration?.owner.id !== owner.id) {
                throw new Error("That MCP registration does not belong to this plugin process.");
            }
            return registration;
        };
        return {
            attach: (registrationId, send) => {
                const registration = requireOwned(registrationId);
                if (registration.active) {
                    throw new Error("That plugin MCP registration is already connected.");
                }
                registration.active = true;
                registration.send = send;
                let attached = true;
                return () => {
                    if (!attached) return;
                    attached = false;
                    this.#retire(registration, "The plugin MCP connection closed.");
                };
            },
            close: () => {
                if (ownerClosed) return;
                ownerClosed = true;
                for (const registration of owned()) {
                    this.#retire(registration, "The plugin process stopped.");
                }
            },
            complete: (registrationId, callId, completion) => {
                const registration = requireOwned(registrationId);
                Value.Assert(happyMcpCallCompletionSchema, completion);
                const call = registration.pendingCalls.get(callId);
                if (call === undefined) {
                    throw new Error("That plugin MCP call is no longer active.");
                }
                registration.pendingCalls.delete(callId);
                call.cleanup();
                call.resolve(happyMcpCompletionToResult(completion));
            },
            register: (server) => {
                if (ownerClosed || this.#closed) {
                    throw new Error("The plugin process is stopping, so it cannot register MCP.");
                }
                const decoded = Value.Decode(happyMcpServerRegistrationSchema, server);
                if (owned().length >= MAXIMUM_SERVERS_PER_PLUGIN) {
                    throw new Error(
                        `A plugin can register at most ${String(MAXIMUM_SERVERS_PER_PLUGIN)} MCP servers.`,
                    );
                }
                this.#assertUnique(owner, decoded);
                const id = randomUUID();
                this.#registrations.set(id, {
                    active: false,
                    id,
                    owner,
                    pendingCalls: new Map(),
                    server: decoded,
                });
                return id;
            },
            unregister: (registrationId) => {
                this.#retire(
                    requireOwned(registrationId),
                    "The plugin unregistered this MCP server.",
                );
            },
        };
    }

    async load(_cwd: string, permissionMode: PermissionMode): Promise<McpToolLoadResult> {
        const registrations = this.#activeRegistrations();
        if (permissionMode !== "auto" && permissionMode !== "full_access") {
            return {
                servers: registrations.map((registration) => ({
                    errorMessage: RESTRICTED_REASON,
                    name: displayServerName(registration),
                    status: "blocked",
                    toolCount: 0,
                })),
                tools: [],
            };
        }
        const tools: AnyDefinedTool[] = [];
        const servers: McpServerSummary[] = [];
        for (const registration of registrations) {
            for (const tool of registration.server.tools) {
                tools.push(this.#createTool(registration, tool));
            }
            servers.push({
                name: displayServerName(registration),
                status: "connected",
                toolCount: registration.server.tools.length,
            });
        }
        return { servers, tools };
    }

    close(): Promise<void> {
        if (this.#closed) return Promise.resolve();
        this.#closed = true;
        for (const registration of this.#registrations.values()) {
            this.#retire(registration, "Rig shut down the plugin MCP catalog.");
        }
        return Promise.resolve();
    }

    #activeRegistrations(): PluginMcpRegistration[] {
        return [...this.#registrations.values()]
            .filter((registration) => registration.active)
            .sort((left, right) => displayServerName(left).localeCompare(displayServerName(right)));
    }

    #assertUnique(owner: PluginMcpOwner, server: HappyMcpServerRegistration): void {
        const pluginKey = normalizedKey(owner.name);
        const serverKey = normalizedKey(`${owner.name}\0${server.name}`);
        const toolKeys = server.tools.map((tool) => normalizedKey(tool.name));
        if (new Set(toolKeys).size !== toolKeys.length) {
            throw new Error(
                `MCP tool names collide after normalization in server "${server.name}".`,
            );
        }
        for (const registration of this.#registrations.values()) {
            if (
                registration.owner.id !== owner.id &&
                normalizedKey(registration.owner.name) === pluginKey
            ) {
                throw new Error(
                    `More than one running plugin is named "${owner.name}", so its MCP identity is ambiguous.`,
                );
            }
            if (
                normalizedKey(`${registration.owner.name}\0${registration.server.name}`) ===
                serverKey
            ) {
                throw new Error(
                    `The plugin MCP server name "${server.name}" collides with an existing registration.`,
                );
            }
            const existingToolKeys = new Set(
                registration.server.tools.map((tool) =>
                    qualifiedToolKey(registration.owner.name, registration.server.name, tool.name),
                ),
            );
            const duplicate = server.tools.find((tool) =>
                existingToolKeys.has(qualifiedToolKey(owner.name, server.name, tool.name)),
            );
            if (duplicate !== undefined) {
                throw new Error(
                    `The plugin MCP tool name "${duplicate.name}" collides with an existing registration.`,
                );
            }
        }
    }

    #createTool(
        registration: PluginMcpRegistration,
        tool: HappyMcpServerRegistration["tools"][number],
    ): AnyDefinedTool {
        const serverName = displayServerName(registration);
        const qualifiedName = createHappyMcpToolName(
            registration.owner.name,
            registration.server.name,
            tool.name,
        );
        return defineTool({
            arguments: Type.Unknown(tool.inputSchema),
            description: tool.description,
            execute: (argumentsValue, _context, execution) =>
                this.#invoke(registration, tool.name, argumentsValue, execution.signal),
            isError: isMcpErrorResult,
            label: qualifiedName,
            locks: [`mcp:${normalizedKey(serverName)}`],
            name: qualifiedName,
            requiresAutoOrFullAccess: true,
            returnType: Type.Unknown(),
            describeAutoPermissionAction: (argumentsValue) =>
                describeMcpAutoPermissionAction({
                    arguments: argumentsValue,
                    server: serverName,
                    tool: tool.name,
                }),
            shouldReviewInAutoMode: () => true,
            toLLM: (result) => mcpResultToContentBlocks(result),
            toUI: () => `${humanizeMcpName(serverName)} · ${humanizeMcpName(tool.name)}`,
        }) as AnyDefinedTool;
    }

    #invoke(
        registration: PluginMcpRegistration,
        tool: string,
        argumentsValue: unknown,
        signal?: AbortSignal,
    ): Promise<HappyMcpToolResult> {
        if (!registration.active || registration.send === undefined) {
            return Promise.reject(new Error("The plugin MCP server is no longer connected."));
        }
        const callId = randomUUID();
        return new Promise<HappyMcpToolResult>((resolve, reject) => {
            let settled = false;
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", cancel);
            };
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                registration.pendingCalls.delete(callId);
                finish();
                reject(error);
            };
            const cancel = () => {
                registration.send?.({ callId, type: "cancel" });
                fail(new Error("The plugin MCP call was cancelled."));
            };
            const timer = setTimeout(() => {
                registration.send?.({ callId, type: "cancel" });
                fail(
                    new Error(
                        `The plugin MCP tool timed out after ${String(this.#callTimeoutMs)}ms.`,
                    ),
                );
            }, this.#callTimeoutMs);
            timer.unref();
            registration.pendingCalls.set(callId, {
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
            if (
                registration.send?.({
                    arguments: argumentsValue,
                    callId,
                    tool,
                    type: "call",
                }) !== true
            ) {
                fail(new Error("The plugin MCP server disconnected before receiving the call."));
            }
        });
    }

    #retire(registration: PluginMcpRegistration, reason: string): void {
        if (this.#registrations.get(registration.id) !== registration) return;
        this.#registrations.delete(registration.id);
        registration.active = false;
        delete registration.send;
        for (const call of registration.pendingCalls.values()) {
            call.cleanup();
            call.reject(new Error(reason));
        }
        registration.pendingCalls.clear();
    }
}

function displayServerName(registration: PluginMcpRegistration): string {
    return `${registration.owner.name} · ${registration.server.name}`;
}

function normalizedKey(value: string): string {
    return normalizeHappyMcpName(value).toLowerCase();
}

function qualifiedToolKey(plugin: string, server: string, tool: string): string {
    return normalizedKey(`${plugin}\0${server}\0${tool}`);
}
