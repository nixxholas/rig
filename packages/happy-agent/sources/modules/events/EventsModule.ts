import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBaseLoop,
    AgentBasePermissionModeChange,
    AgentBaseSettlement,
    AgentBaseToolOutcome,
    AgentBaseTurn,
    AgentMetadataChange,
    AgentModule,
    AgentModuleAgentLifecycle,
    AgentModuleScope,
    AgentModuleSystemScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { createUuidV7Factory } from "./createUuidV7.js";

export const happyAgentEventIdSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

export const happyAgentEventSchema = Type.Object(
    {
        agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        id: happyAgentEventIdSchema,
        occurredAt: Type.Integer({ minimum: 0 }),
        payload: Type.Unknown(),
        type: Type.String({
            minLength: 1,
            maxLength: 128,
            pattern: "^[a-z][a-z0-9.-]*$",
        }),
    },
    { additionalProperties: false },
);

export type HappyAgentEvent = Static<typeof happyAgentEventSchema>;

export interface AppendHappyAgentEvent {
    readonly agentId?: string;
    readonly payload: unknown;
    readonly type: string;
}

export interface EventsModuleOptions {
    readonly capacity?: number;
    readonly now?: () => number;
}

export interface EventReplay {
    readonly cursor: string;
    readonly events: readonly HappyAgentEvent[];
    readonly latestCursor: string;
}

export type HappyAgentEventListener = (event: HappyAgentEvent) => void;

/**
 * The daemon's bounded, process-local event journal.
 *
 * Agent Base already owns durable conversation state. This module is deliberately an observation
 * surface: reconnecting clients replay what remains in memory, then resynchronize from `/v0/agent`
 * when their cursor has expired.
 */
export class EventsModule implements AgentModule<AnyAgentTool, LibSQLDatabase> {
    readonly name = "events";
    readonly #capacity: number;
    readonly #createId: () => string;
    readonly #entries: HappyAgentEvent[] = [];
    readonly #listeners = new Set<HappyAgentEventListener>();
    readonly #now: () => number;
    #originCursor: string;
    #occurredAt = 0;

    constructor(options: EventsModuleOptions = {}) {
        const capacity = options.capacity ?? 10_000;
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) {
            throw new Error("The event queue capacity must be between 1 and 100,000.");
        }
        this.#capacity = capacity;
        this.#now = options.now ?? Date.now;
        this.#createId = createUuidV7Factory(this.#now);
        this.#originCursor = this.#createId();
    }

    cursor(): string {
        return this.#entries.at(-1)?.id ?? this.#originCursor;
    }

    capacity(): number {
        return this.#capacity;
    }

    append(input: AppendHappyAgentEvent): HappyAgentEvent {
        const event: HappyAgentEvent = {
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            id: this.#createId(),
            occurredAt: Math.max(this.#occurredAt, Math.max(0, Math.trunc(this.#now()))),
            payload: snapshotPayload(input.payload),
            type: input.type,
        };
        if (!Value.Check(happyAgentEventSchema, event)) {
            throw new Error("The Happy agent event is invalid.");
        }
        deepFreeze(event);
        this.#occurredAt = event.occurredAt;
        this.#entries.push(event);
        while (this.#entries.length > this.#capacity) {
            const removed = this.#entries.shift();
            if (removed !== undefined) this.#originCursor = removed.id;
        }
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch {
                // An event is already ordered and visible. One broken observer cannot starve others.
            }
        }
        return event;
    }

    replay(after?: string, limit = this.#capacity): EventReplay | undefined {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#capacity) {
            throw new Error(`The event replay limit must be between 1 and ${this.#capacity}.`);
        }
        const latestCursor = this.cursor();
        if (after === undefined) {
            return { cursor: latestCursor, events: [], latestCursor };
        }
        if (after === this.#originCursor) {
            const events = this.#entries.slice(0, limit);
            return {
                cursor: events.at(-1)?.id ?? after,
                events,
                latestCursor,
            };
        }
        const index = this.#entries.findIndex((event) => event.id === after);
        if (index < 0) return undefined;
        const events = this.#entries.slice(index + 1, index + 1 + limit);
        return {
            cursor: events.at(-1)?.id ?? after,
            events,
            latestCursor,
        };
    }

    trim(through: string): { readonly through: string; readonly trimmed: number } | undefined {
        if (!Value.Check(happyAgentEventIdSchema, through)) return undefined;
        if (through === this.#originCursor) {
            return { through, trimmed: 0 };
        }
        const index = this.#entries.findIndex((event) => event.id === through);
        if (index < 0) return undefined;
        this.#entries.splice(0, index + 1);
        this.#originCursor = through;
        return { through, trimmed: index + 1 };
    }

    subscribe(listener: HappyAgentEventListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    agentCreatedTransact(
        ctx: Context,
        _scope: AgentModuleSystemScope<LibSQLDatabase>,
        agent: AgentModuleAgentLifecycle,
    ): void {
        this.afterCommitEvent(ctx, { agentId: agent.id, payload: agent, type: "agent.created" });
    }

    agentRestoredTransact(
        ctx: Context,
        _scope: AgentModuleSystemScope<LibSQLDatabase>,
        agent: AgentModuleAgentLifecycle,
    ): void {
        this.afterCommitEvent(ctx, { agentId: agent.id, payload: agent, type: "agent.restored" });
    }

    agentArchivedTransact(
        ctx: Context,
        _scope: AgentModuleSystemScope<LibSQLDatabase>,
        agent: AgentModuleAgentLifecycle,
    ): void {
        this.afterCommitEvent(ctx, { agentId: agent.id, payload: agent, type: "agent.archived" });
    }

    messageAccepted(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        accepted: AgentBaseAcceptedMessage,
    ): void {
        this.append({
            agentId: scope.agent.id,
            payload: accepted,
            type: "message.accepted",
        });
    }

    permissionModeChanged(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        change: AgentBasePermissionModeChange,
    ): void {
        this.append({
            agentId: scope.agent.id,
            payload: change,
            type: "agent.permission-changed",
        });
    }

    metadataChanged(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        change: AgentMetadataChange,
    ): void {
        this.append({
            agentId: scope.agent.id,
            payload: change,
            type: "agent.metadata-changed",
        });
    }

    beforeAgentLoop(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        loop: AgentBaseLoop,
    ): void {
        this.append({ agentId: scope.agent.id, payload: loop, type: "loop.started" });
    }

    onEvent(_ctx: Context, scope: AgentModuleScope<LibSQLDatabase>, event: SessionEvent): void {
        this.append({ agentId: scope.agent.id, payload: event, type: "provider.event" });
    }

    afterToolCall(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        outcome: AgentBaseToolOutcome,
    ): void {
        this.append({
            agentId: scope.agent.id,
            payload: outcome,
            type: "tool.completed",
        });
    }

    afterInference(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        inference: AgentBaseInference,
    ): void {
        this.append({
            agentId: scope.agent.id,
            payload: inference,
            type: "inference.completed",
        });
    }

    afterTurn(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        turn: AgentBaseTurn,
    ): undefined {
        this.append({ agentId: scope.agent.id, payload: turn, type: "turn.completed" });
        return undefined;
    }

    afterAgentSettled(
        _ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        settlement: AgentBaseSettlement,
    ): void {
        this.append({
            agentId: scope.agent.id,
            payload: settlement,
            type: "loop.settled",
        });
    }

    private afterCommitEvent(ctx: Context, event: AppendHappyAgentEvent): void {
        afterCommit(ctx, () => {
            this.append(event);
        });
    }
}

function snapshotPayload(payload: unknown): unknown {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(payload, (_key, value: unknown) => {
        if (typeof value === "bigint") return value.toString();
        if (value instanceof Error) return { message: value.message, name: value.name };
        if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[Circular]";
            seen.add(value);
        }
        return value;
    });
    return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
}

function deepFreeze(value: unknown): void {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
}
