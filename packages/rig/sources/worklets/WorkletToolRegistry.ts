import { randomUUID } from "node:crypto";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { defineTool, type AnyDefinedTool } from "../agent/types.js";
import { humanizeMcpName } from "../mcp/humanizeMcpName.js";
import { isMcpErrorResult } from "../mcp/isMcpErrorResult.js";
import { mcpResultToContentBlocks } from "../mcp/mcpResultToContentBlocks.js";
import type { McpServerSummary, McpToolLoadResult, McpToolProvider } from "../mcp/types.js";
import type { PermissionMode } from "../permissions/index.js";
import type { WorkletPermissions, WorkletTool } from "../protocol/WorkletProtocol.js";
import { describeWorkletPermissions } from "./describeWorkletPermissions.js";
import {
    workletCallCompletionSchema,
    workletToolRegistrationSchema,
    type WorkletCallCompletion,
    type WorkletStreamEvent,
    type WorkletToolRegistration,
    type WorkletToolResult,
} from "./workletWire.js";

const DEFAULT_WORKLET_CALL_TIMEOUT_MS = 30_000;
const MAXIMUM_TOOLS_PER_WORKLET = 64;
const RESTRICTED_REASON =
    "Worklet tools are available in Auto or Full access because a worklet runs outside Rig's per-command sandbox.";

interface PendingWorkletCall {
    cleanup(): void;
    reject(error: Error): void;
    resolve(result: WorkletToolResult): void;
}

interface WorkletRegistration {
    active: boolean;
    id: string;
    owner: WorkletOwner;
    pendingCalls: Map<string, PendingWorkletCall>;
    send?: (event: WorkletStreamEvent) => boolean;
    tools: readonly WorkletToolRegistration[];
}

interface WorkletOwner {
    id: string;
    name: string;
    permissions: WorkletPermissions;
    onActiveRegistrationRetired?: (retirement: WorkletRegistrationRetirement) => void;
}

export type WorkletRegistrationRetirement = { reason: string; status: "failed" | "stopped" };

export interface WorkletToolConnectionOptions {
    onActiveRegistrationRetired?: (retirement: WorkletRegistrationRetirement) => void;
}

export interface WorkletToolConnection {
    readonly generation: string;
    attach(registrationId: string, send: (event: WorkletStreamEvent) => boolean): () => void;
    close(): void;
    complete(registrationId: string, callId: string, completion: WorkletCallCompletion): void;
    /** The tools this generation declared, in the order it declared them. */
    declared(): readonly WorkletTool[];
    register(tools: readonly WorkletToolRegistration[]): string;
}

/**
 * The daemon-wide live catalog of tools declared by running worklets.
 *
 * A registration becomes callable only once the worklet attaches its NDJSON call stream, so a
 * model never sees a tool nothing is listening for. Retiring a worklet rejects its pending calls
 * synchronously, so a result from a stopped generation can never land after a restart.
 */
export class WorkletToolRegistry implements McpToolProvider {
    readonly #callTimeoutMs: number;
    readonly #registrations = new Map<string, WorkletRegistration>();
    #closed = false;
    #revision = 0;

    constructor(options: { callTimeoutMs?: number } = {}) {
        this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_WORKLET_CALL_TIMEOUT_MS;
    }

    get revision(): number {
        return this.#revision;
    }

    createConnection(
        worklet: { name: string; permissions: WorkletPermissions },
        options: WorkletToolConnectionOptions = {},
    ): WorkletToolConnection {
        if (this.#closed) {
            throw new Error("Rig is shutting down, so worklet tools are unavailable.");
        }
        const owner: WorkletOwner = {
            id: randomUUID(),
            name: worklet.name,
            permissions: worklet.permissions,
            ...(options.onActiveRegistrationRetired === undefined
                ? {}
                : { onActiveRegistrationRetired: options.onActiveRegistrationRetired }),
        };
        let ownerClosed = false;
        const owned = () =>
            [...this.#registrations.values()].filter(
                (registration) => registration.owner.id === owner.id,
            );
        const requireOwned = (registrationId: string): WorkletRegistration => {
            const registration = this.#registrations.get(registrationId);
            if (registration?.owner.id !== owner.id) {
                throw new Error("That tool registration does not belong to this worklet.");
            }
            return registration;
        };
        return {
            generation: owner.id,
            attach: (registrationId, send) => {
                const registration = requireOwned(registrationId);
                if (registration.active) {
                    throw new Error("That worklet tool registration is already connected.");
                }
                registration.active = true;
                registration.send = send;
                this.#revision += 1;
                let attached = true;
                return () => {
                    if (!attached) return;
                    attached = false;
                    this.#retire(registration, {
                        reason: "The worklet's tool connection closed.",
                        status: "failed",
                    });
                };
            },
            close: () => {
                if (ownerClosed) return;
                ownerClosed = true;
                for (const registration of owned()) {
                    this.#retire(registration, {
                        reason: "The worklet stopped.",
                        status: "failed",
                    });
                }
            },
            complete: (registrationId, callId, completion) => {
                const registration = requireOwned(registrationId);
                Value.Assert(workletCallCompletionSchema, completion);
                const call = registration.pendingCalls.get(callId);
                if (call === undefined)
                    throw new Error("That worklet tool call is no longer active.");
                registration.pendingCalls.delete(callId);
                call.cleanup();
                if ("error" in completion) {
                    call.resolve({
                        content: [{ text: completion.error, type: "text" }],
                        isError: true,
                    });
                    return;
                }
                call.resolve(completion.result);
            },
            declared: () =>
                owned().flatMap((registration) =>
                    registration.tools.map((tool) => ({
                        description: tool.description,
                        name: tool.name,
                    })),
                ),
            register: (tools) => {
                if (ownerClosed || this.#closed) {
                    throw new Error("The worklet is stopping, so it cannot register tools.");
                }
                if (owned().length > 0) {
                    throw new Error("A worklet declares its tools once, before it reports ready.");
                }
                if (tools.length > MAXIMUM_TOOLS_PER_WORKLET) {
                    throw new Error(
                        `A worklet can declare at most ${String(MAXIMUM_TOOLS_PER_WORKLET)} tools.`,
                    );
                }
                const decoded = tools.map((tool) =>
                    Value.Decode(workletToolRegistrationSchema, tool),
                );
                this.#assertUnique(owner, decoded);
                const id = randomUUID();
                this.#registrations.set(id, {
                    active: false,
                    id,
                    owner,
                    pendingCalls: new Map(),
                    tools: decoded,
                });
                return id;
            },
        };
    }

    async load(_cwd: string, permissionMode: PermissionMode): Promise<McpToolLoadResult> {
        const registrations = this.#activeRegistrations();
        if (permissionMode !== "auto" && permissionMode !== "full_access") {
            return {
                servers: registrations.map((registration) => ({
                    errorMessage: RESTRICTED_REASON,
                    name: registration.owner.name,
                    status: "blocked",
                    toolCount: 0,
                })),
                tools: [],
            };
        }
        const tools: AnyDefinedTool[] = [];
        const servers: McpServerSummary[] = [];
        for (const registration of registrations) {
            for (const tool of registration.tools) tools.push(this.#createTool(registration, tool));
            servers.push({
                name: registration.owner.name,
                status: "connected",
                toolCount: registration.tools.length,
            });
        }
        return { servers, tools };
    }

    close(): Promise<void> {
        if (this.#closed) return Promise.resolve();
        this.#closed = true;
        for (const registration of this.#registrations.values()) {
            this.#retire(registration, {
                reason: "Rig shut down the worklet tool catalog.",
                status: "failed",
            });
        }
        return Promise.resolve();
    }

    #activeRegistrations(): WorkletRegistration[] {
        return [...this.#registrations.values()]
            .filter((registration) => registration.active)
            .sort((left, right) => left.owner.name.localeCompare(right.owner.name));
    }

    #assertUnique(owner: WorkletOwner, tools: readonly WorkletToolRegistration[]): void {
        const names = tools.map((tool) => tool.name.toLowerCase());
        if (new Set(names).size !== names.length) {
            throw new Error("This worklet declared two tools with the same name.");
        }
        for (const registration of this.#registrations.values()) {
            if (
                registration.owner.id !== owner.id &&
                registration.owner.name.toLowerCase() === owner.name.toLowerCase()
            ) {
                throw new Error(
                    `More than one running worklet is named "${owner.name}", so its tools are ambiguous.`,
                );
            }
        }
    }

    #createTool(registration: WorkletRegistration, tool: WorkletToolRegistration): AnyDefinedTool {
        const qualifiedName = workletToolName(registration.owner.name, tool.name);
        return defineTool({
            arguments: Type.Unknown(tool.inputSchema),
            description: tool.description,
            execute: (argumentsValue, _context, execution) =>
                this.#invoke(registration, tool.name, argumentsValue, execution.signal),
            isError: isMcpErrorResult,
            label: qualifiedName,
            locks: [`worklet:${registration.owner.name.toLowerCase()}`],
            name: qualifiedName,
            requiresAutoOrFullAccess: true,
            returnType: Type.Unknown(),
            describeAutoPermissionAction: (argumentsValue) =>
                `call the ${tool.name} tool of the ${registration.owner.name} worklet with ${JSON.stringify(argumentsValue)}. Access: the worklet runs persistent code outside Rig's per-command sandbox. ${describeWorkletPermissions(registration.owner.permissions)}`,
            shouldReviewInAutoMode: () => true,
            toLLM: (result) => mcpResultToContentBlocks(result),
            toUI: () =>
                `${humanizeMcpName(registration.owner.name)} · ${humanizeMcpName(tool.name)}`,
        }) as AnyDefinedTool;
    }

    #invoke(
        registration: WorkletRegistration,
        tool: string,
        argumentsValue: unknown,
        signal?: AbortSignal,
    ): Promise<WorkletToolResult> {
        if (!registration.active || registration.send === undefined) {
            return Promise.reject(new Error("The worklet is no longer connected."));
        }
        const callId = randomUUID();
        return new Promise<WorkletToolResult>((resolve, reject) => {
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
                fail(new Error("The worklet tool call was cancelled."));
            };
            const timer = setTimeout(() => {
                registration.send?.({ callId, type: "cancel" });
                fail(
                    new Error(`The worklet tool timed out after ${String(this.#callTimeoutMs)}ms.`),
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
                registration.send?.({ arguments: argumentsValue, callId, tool, type: "call" }) !==
                true
            ) {
                fail(new Error("The worklet disconnected before receiving the call."));
            }
        });
    }

    #retire(registration: WorkletRegistration, retirement: WorkletRegistrationRetirement): void {
        if (this.#registrations.get(registration.id) !== registration) return;
        const wasActive = registration.active;
        this.#registrations.delete(registration.id);
        registration.active = false;
        delete registration.send;
        for (const call of registration.pendingCalls.values()) {
            call.cleanup();
            call.reject(new Error(retirement.reason));
        }
        registration.pendingCalls.clear();
        if (wasActive) this.#revision += 1;
        if (wasActive) registration.owner.onActiveRegistrationRetired?.(retirement);
    }
}

/** A worklet's tools are named for the worklet that owns them, then the tool itself. */
export function workletToolName(worklet: string, tool: string): string {
    return `worklet_${worklet.replaceAll("-", "_")}_${tool}`;
}
