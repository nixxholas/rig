import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBaseLoop,
    AgentBasePermissionModeChange,
    AgentBaseSettlement,
    AgentBaseTurn,
    AgentDatabase,
    AgentMetadataChange,
    AgentModule,
    AgentModuleAgentLifecycle,
    AgentModuleScope,
    AgentModuleSystemScope,
    AgentStorageTransaction,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type {
    SessionEvent,
    SessionOutputBlock,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import {
    deleteActiveRun,
    eventsMigrations,
    insertEvent,
    loadActiveRuns,
    loadEventState,
    saveActiveRun,
    saveOriginCursor,
    trimEvents,
    validateAppendEvent,
} from "./EventsDatabase.js";
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
const unknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type UnknownRecord = Static<typeof unknownRecordSchema>;

const activeRunSchema = Type.Object(
    {
        activeIndex: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        activeKind: Type.Union([
            Type.Literal("reasoning"),
            Type.Literal("text"),
            Type.Literal("tool"),
            Type.Null(),
        ]),
        argumentBuffers: Type.Record(Type.String(), Type.String()),
        blocks: Type.Array(Type.Unknown()),
        callIndexes: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
        runId: Type.String({ minLength: 1, maxLength: 256 }),
        stopReason: Type.Union([
            Type.Literal("aborted"),
            Type.Literal("error"),
            Type.Literal("length"),
            Type.Literal("stop"),
        ]),
        text: Type.String(),
    },
    { additionalProperties: false },
);
type ActiveRun = Static<typeof activeRunSchema>;

export interface AppendHappyAgentEvent {
    readonly agentId?: string;
    readonly payload: unknown;
    readonly type: string;
}

export interface EventsModuleOptions {
    readonly capacity?: number;
    readonly now?: () => number;
}

export interface EventsModuleRuntimeOptions extends EventsModuleOptions {
    readonly transaction: AgentStorageTransaction<LibSQLDatabase>;
}

export interface EventReplay {
    readonly cursor: string;
    readonly events: readonly HappyAgentEvent[];
    readonly latestCursor: string;
}

export type HappyAgentEventListener = (event: HappyAgentEvent) => void;

/**
 * The daemon's durable, bounded event journal.
 *
 * Provider `SessionEvent` values are stored verbatim. A separate `rigEvent` projection is attached
 * when Rig's current transcript reducer needs its indexed message shape; it is an adapter, never
 * a replacement for the provider event.
 */
export class EventsModule implements AgentModule<AnyAgentTool, LibSQLDatabase> {
    readonly name = "events";
    readonly migrations = eventsMigrations;
    readonly #capacity: number;
    readonly #entries: HappyAgentEvent[] = [];
    readonly #listeners = new Set<HappyAgentEventListener>();
    readonly #now: () => number;
    readonly #runs = new Map<string, ActiveRun>();
    readonly #transaction: AgentStorageTransaction<LibSQLDatabase>;
    #createId: () => string;
    #originCursor: string;
    #occurredAt = 0;

    constructor(options: EventsModuleRuntimeOptions) {
        const capacity = options.capacity ?? 10_000;
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) {
            throw new Error("The event queue capacity must be between 1 and 100,000.");
        }
        this.#capacity = capacity;
        this.#now = options.now ?? Date.now;
        this.#createId = createUuidV7Factory(this.#now);
        this.#originCursor = this.#createId();
        this.#transaction = options.transaction;
    }

    readonly beforeStart = async (
        _ctx: Context,
        _agents: unknown,
        database: LibSQLDatabase,
    ): Promise<void> => {
        const loaded = await loadEventState(database, this.#capacity);
        this.#entries.push(...loaded.events.map(freezeEvent));
        this.#occurredAt = this.#entries.at(-1)?.occurredAt ?? 0;
        this.#originCursor = loaded.originCursor ?? this.#originCursor;
        const highWater = this.#entries.at(-1)?.id ?? this.#originCursor;
        this.#createId = createUuidV7Factory(this.#now, highWater);
        const runs = await loadActiveRuns(database, parseActiveRun);
        for (const [agentId, run] of runs) this.#runs.set(agentId, run);
    };

    cursor(): string {
        return this.#entries.at(-1)?.id ?? this.#originCursor;
    }

    originCursor(): string {
        return this.#originCursor;
    }

    capacity(): number {
        return this.#capacity;
    }

    async record(ctx: Context, input: AppendHappyAgentEvent): Promise<HappyAgentEvent> {
        return await this.#transaction(ctx, async (txCtx, database) => {
            return await this.recordInDatabase(txCtx, database, input);
        });
    }

    replay(after?: string, limit = this.#capacity): EventReplay | undefined {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#capacity) {
            throw new Error(`The event replay limit must be between 1 and ${this.#capacity}.`);
        }
        const latestCursor = this.cursor();
        if (after === undefined) return { cursor: latestCursor, events: [], latestCursor };
        if (after === this.#originCursor) {
            const events = this.#entries.slice(0, limit);
            return { cursor: events.at(-1)?.id ?? after, events, latestCursor };
        }
        const index = this.#entries.findIndex((event) => event.id === after);
        if (index < 0) return undefined;
        const events = this.#entries.slice(index + 1, index + 1 + limit);
        return { cursor: events.at(-1)?.id ?? after, events, latestCursor };
    }

    async trim(
        ctx: Context,
        through: string,
    ): Promise<{ readonly through: string; readonly trimmed: number } | undefined> {
        if (!Value.Check(happyAgentEventIdSchema, through)) return undefined;
        if (through === this.#originCursor) return { through, trimmed: 0 };
        return await this.#transaction(ctx, async (txCtx, database) => {
            const trimmed = await trimEvents(database, through);
            if (trimmed === undefined) return undefined;
            afterCommit(txCtx, () => {
                const index = this.#entries.findIndex((event) => event.id === through);
                if (index >= 0) this.#entries.splice(0, index + 1);
                this.#originCursor = through;
            });
            return { through, trimmed };
        });
    }

    subscribe(listener: HappyAgentEventListener): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    messageCursor(agentId: string, messageId: string): string | undefined {
        return this.#entries.findLast(
            (event) =>
                event.agentId === agentId &&
                event.type === "message.accepted" &&
                recordValue(event.payload)?.id === messageId,
        )?.id;
    }

    readonly agentCreatedTransact = async (
        ctx: Context,
        scope: AgentModuleSystemScope<LibSQLDatabase>,
        agent: AgentModuleAgentLifecycle,
    ): Promise<void> => {
        await this.recordInDatabase(ctx, scope.database, {
            agentId: agent.id,
            payload: agent,
            type: "agent.created",
        });
    };

    readonly agentRestoredTransact = async (
        ctx: Context,
        scope: AgentModuleSystemScope<LibSQLDatabase>,
        agent: AgentModuleAgentLifecycle,
    ): Promise<void> => {
        await this.recordInDatabase(ctx, scope.database, {
            agentId: agent.id,
            payload: agent,
            type: "agent.restored",
        });
        const run = this.#runs.get(agent.id);
        if (run !== undefined) {
            const projected = projectProviderEvent(run, { type: "block_reset" }, this.#now());
            await saveActiveRun(scope.database, agent.id, projected.run);
            await this.recordInDatabase(ctx, scope.database, {
                agentId: agent.id,
                payload: {
                    event: { type: "block_reset" },
                    recovered: true,
                    rigEvent: projected.rigEvent,
                    runId: run.runId,
                },
                type: "provider.event",
            });
        }
    };

    readonly agentArchivedTransact = async (
        ctx: Context,
        scope: AgentModuleSystemScope<LibSQLDatabase>,
        agent: AgentModuleAgentLifecycle,
    ): Promise<void> => {
        await this.recordInDatabase(ctx, scope.database, {
            agentId: agent.id,
            payload: agent,
            type: "agent.archived",
        });
    };

    readonly messageAcceptedTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        const previous = this.#runs.get(scope.agent.id);
        const run =
            accepted.kind === "steering" && previous !== undefined
                ? previous
                : emptyRun(accepted.id);
        await saveActiveRun(scope.database, scope.agent.id, run);
        afterCommit(ctx, () => {
            this.#runs.set(scope.agent.id, run);
        });
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: { ...accepted, runId: run.runId },
            type: "message.accepted",
        });
    };

    readonly permissionModeChangedTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        change: AgentBasePermissionModeChange,
    ): Promise<void> => {
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: change,
            type: "agent.permission-changed",
        });
    };

    readonly metadataChangedTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        change: AgentMetadataChange,
    ): Promise<void> => {
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: change,
            type: "agent.metadata-changed",
        });
    };

    readonly beforeAgentLoopTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        loop: AgentBaseLoop,
    ): Promise<void> => {
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: {
                ...loop,
                runId: this.#runs.get(scope.agent.id)?.runId ?? loop.loopId,
            },
            type: "loop.started",
        });
    };

    readonly onEvent = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        event: SessionEvent,
    ): Promise<void> => {
        await this.#transaction(ctx, async (txCtx, database) => {
            const current = this.#runs.get(scope.agent.id) ?? emptyRun(this.#createId());
            const projected = projectProviderEvent(current, event, this.#now());
            await saveActiveRun(database, scope.agent.id, projected.run);
            afterCommit(txCtx, () => {
                this.#runs.set(scope.agent.id, projected.run);
            });
            await this.recordInDatabase(txCtx, database, {
                agentId: scope.agent.id,
                payload: {
                    event,
                    rigEvent: projected.rigEvent,
                    runId: projected.run.runId,
                    ...(event.type === "text_end" ? { text: projected.run.text } : {}),
                },
                type: "provider.event",
            });
        });
    };

    readonly beforeToolCallTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        call: SessionToolCallBlock,
    ): Promise<void> => {
        const runId = this.#runs.get(scope.agent.id)?.runId ?? call.callId;
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: {
                rigEvent: {
                    toolCall: presentedToolCall(call),
                    type: "tool_execution_start",
                },
                runId,
            },
            type: "tool.started",
        });
    };

    readonly afterToolCallTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        result: SessionToolResultMessage,
    ): Promise<void> => {
        const run = this.#runs.get(scope.agent.id);
        const toolName = toolNameForCall(run, result.callId);
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: {
                ...result,
                rigEvent: toolExecutionEnd(result.callId, toolName, result.content, result.isError),
                runId: run?.runId,
            },
            type: "tool.completed",
        });
    };

    readonly afterInferenceTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        inference: AgentBaseInference,
    ): Promise<void> => {
        const run = this.#runs.get(scope.agent.id);
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: {
                ...inference,
                blocks: run?.blocks ?? [],
                runId: run?.runId ?? inference.loopId,
                text: run?.text ?? "",
            },
            type: "inference.completed",
        });
    };

    readonly afterTurnTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        turn: AgentBaseTurn,
    ): Promise<void> => {
        const run = this.#runs.get(scope.agent.id);
        const next =
            run !== undefined && turn.aborted ? { ...run, stopReason: "aborted" as const } : run;
        if (next !== undefined) {
            await saveActiveRun(scope.database, scope.agent.id, next);
            afterCommit(ctx, () => {
                this.#runs.set(scope.agent.id, next);
            });
        }
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: { ...turn, runId: next?.runId ?? turn.loopId },
            type: "turn.completed",
        });
    };

    readonly afterAgentSettledTransact = async (
        ctx: Context,
        scope: AgentModuleScope<LibSQLDatabase>,
        settlement: AgentBaseSettlement,
    ): Promise<void> => {
        const run = this.#runs.get(scope.agent.id);
        await this.recordInDatabase(ctx, scope.database, {
            agentId: scope.agent.id,
            payload: {
                ...settlement,
                runId: run?.runId ?? settlement.loopId,
                stopReason: run?.stopReason ?? "stop",
            },
            type: "loop.settled",
        });
        await deleteActiveRun(scope.database, scope.agent.id);
        afterCommit(ctx, () => {
            this.#runs.delete(scope.agent.id);
        });
    };

    private async recordInDatabase(
        ctx: Context,
        database: AgentDatabase,
        input: AppendHappyAgentEvent,
    ): Promise<HappyAgentEvent> {
        validateAppendEvent(input);
        const event = freezeEvent({
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            id: this.#createId(),
            occurredAt: Math.max(this.#occurredAt, Math.max(0, Math.trunc(this.#now()))),
            payload: snapshotPayload(input.payload),
            type: input.type,
        });
        if (!Value.Check(happyAgentEventSchema, event)) {
            throw new Error("The Happy agent event is invalid.");
        }
        await saveOriginCursor(database, this.#originCursor);
        await insertEvent(database, event, this.#capacity);
        afterCommit(ctx, () => this.publish(event));
        return event;
    }

    private publish(event: HappyAgentEvent): void {
        if (this.#entries.some((candidate) => candidate.id === event.id)) return;
        this.#occurredAt = Math.max(this.#occurredAt, event.occurredAt);
        this.#entries.push(event);
        while (this.#entries.length > this.#capacity) {
            const removed = this.#entries.shift();
            if (removed !== undefined) this.#originCursor = removed.id;
        }
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch {
                // One observer cannot starve the ordered journal or its other subscribers.
            }
        }
    }
}

function emptyRun(runId: string): ActiveRun {
    return {
        activeIndex: null,
        activeKind: null,
        argumentBuffers: {},
        blocks: [],
        callIndexes: {},
        runId,
        stopReason: "stop",
        text: "",
    };
}

function parseActiveRun(value: unknown): ActiveRun {
    if (!Value.Check(activeRunSchema, value)) throw new Error("A durable active run is invalid.");
    return value;
}

function projectProviderEvent(
    previous: ActiveRun,
    event: SessionEvent,
    now: number,
): { readonly rigEvent?: UnknownRecord; readonly run: ActiveRun } {
    let run = structuredClone(previous);
    let rigEvent: UnknownRecord | undefined;
    const messageId = `${run.runId}-assistant`;
    if (event.type === "block_start") {
        run = { ...emptyRun(run.runId), stopReason: run.stopReason };
        rigEvent = { messageId, type: "block_start" };
    } else if (event.type === "block_stop") {
        run.activeIndex = null;
        run.activeKind = null;
        rigEvent = { messageId, type: "block_stop" };
    } else if (event.type === "block_reset") {
        run = { ...emptyRun(run.runId), stopReason: run.stopReason };
        rigEvent = { messageId, partial: partialMessage(run, now), type: "block_reset" };
    } else if (event.type === "text_start") {
        run.activeIndex = run.blocks.length;
        run.activeKind = "text";
        run.blocks.push({ text: "", type: "text" });
        rigEvent = {
            contentIndex: run.activeIndex,
            messageId,
            partial: partialMessage(run, now),
            type: "text_start",
        };
    } else if (event.type === "text_delta") {
        const index = requireActive(run, "text");
        const block = recordValue(run.blocks[index]);
        const text = typeof block?.text === "string" ? block.text + event.delta : event.delta;
        run.blocks[index] = { text, type: "text" };
        run.text += event.delta;
        rigEvent = {
            contentIndex: index,
            delta: event.delta,
            messageId,
            partial: partialMessage(run, now),
            type: "text_delta",
        };
    } else if (event.type === "text_end") {
        const index = requireActive(run, "text");
        const content = String(recordValue(run.blocks[index])?.text ?? "");
        rigEvent = {
            content,
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            type: "text_end",
        };
    } else if (event.type === "reasoning_start") {
        run.activeIndex = run.blocks.length;
        run.activeKind = "reasoning";
        run.blocks.push({ thinking: "", type: "thinking" });
        rigEvent = {
            contentIndex: run.activeIndex,
            messageId,
            partial: partialMessage(run, now),
            type: "thinking_start",
        };
    } else if (event.type === "reasoning_delta") {
        const index = requireActive(run, "reasoning");
        const block = recordValue(run.blocks[index]);
        const thinking =
            typeof block?.thinking === "string" ? block.thinking + event.delta : event.delta;
        run.blocks[index] = { thinking, type: "thinking" };
        rigEvent = {
            contentIndex: index,
            delta: event.delta,
            messageId,
            partial: partialMessage(run, now),
            type: "thinking_delta",
        };
    } else if (event.type === "reasoning_end") {
        const index = requireActive(run, "reasoning");
        const block = recordValue(run.blocks[index]);
        const content =
            event.reasoning ?? (typeof block?.thinking === "string" ? block.thinking : "");
        run.blocks[index] = { thinking: content, type: "thinking" };
        rigEvent = {
            content,
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            type: "thinking_end",
        };
    } else if (event.type === "toolcall_start") {
        const index = run.blocks.length;
        run.activeIndex = index;
        run.activeKind = "tool";
        run.callIndexes[event.callId] = index;
        run.argumentBuffers[event.callId] = "";
        run.blocks.push({
            arguments: {},
            id: event.callId,
            name: event.name,
            ...(event.namespace === undefined ? {} : { namespace: event.namespace }),
            providerToolCallId: event.callId,
            type: "toolCall",
            ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
        });
        rigEvent = {
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            type: "toolcall_start",
        };
    } else if (event.type === "toolcall_delta") {
        const index = run.callIndexes[event.callId] ?? requireActive(run, "tool");
        run.argumentBuffers[event.callId] = (run.argumentBuffers[event.callId] ?? "") + event.delta;
        rigEvent = {
            contentIndex: index,
            delta: event.delta,
            messageId,
            partial: partialMessage(run, now),
            type: "toolcall_delta",
        };
    } else if (event.type === "toolcall_end") {
        const index = run.callIndexes[event.callId] ?? requireActive(run, "tool");
        const block = recordValue(run.blocks[index]) ?? {};
        const toolCall = {
            ...block,
            arguments: parseToolArguments(event.arguments),
            id: event.callId,
            incomplete: event.incomplete,
            type: "toolCall",
        };
        run.blocks[index] = toolCall;
        rigEvent = {
            contentIndex: index,
            messageId,
            partial: partialMessage(run, now),
            toolCall,
            type: "toolcall_end",
        };
    } else if (event.type === "toolcall_result_start") {
        const index = run.callIndexes[event.callId];
        const block = index === undefined ? undefined : recordValue(run.blocks[index]);
        rigEvent = {
            toolCall: {
                ...(block ?? {
                    arguments: {},
                    id: event.callId,
                    name: "server_tool",
                    type: "toolCall",
                }),
            },
            type: "tool_execution_start",
        };
    } else if (event.type === "toolcall_result_delta") {
        rigEvent = {
            display: event.delta,
            toolCallId: event.callId,
            type: "tool_execution_progress",
        };
    } else if (event.type === "toolcall_result_end") {
        const toolName = toolNameForCall(run, event.callId);
        const result = toolExecutionEnd(event.callId, toolName, event.content, event.isError);
        run.blocks.push(result.result);
        rigEvent = result;
    } else if (event.type === "retrying") {
        rigEvent = { ...event, messageId };
    } else if (event.type === "done") {
        run.stopReason =
            event.state === "cancelled"
                ? "aborted"
                : event.state === "error"
                  ? "error"
                  : event.state === "length"
                    ? "length"
                    : "stop";
    }
    return { ...(rigEvent === undefined ? {} : { rigEvent }), run };
}

function presentedToolCall(call: SessionToolCallBlock): UnknownRecord {
    return {
        arguments: parseToolArguments(call.arguments),
        id: call.callId,
        name: call.name,
        ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
        providerToolCallId: call.callId,
        type: "toolCall",
        ...(call.vendor === undefined ? {} : { vendor: call.vendor }),
    };
}

function toolNameForCall(run: ActiveRun | undefined, callId: string): string {
    if (run === undefined) return "tool";
    const index = run.callIndexes[callId];
    const name = index === undefined ? undefined : recordValue(run.blocks[index])?.name;
    return typeof name === "string" ? name : "tool";
}

function toolExecutionEnd(
    callId: string,
    toolName: string,
    content: readonly SessionOutputBlock[],
    isError: boolean | undefined,
): UnknownRecord {
    const rendered = content.map((block) =>
        block.type === "text"
            ? { text: block.text, type: "text" }
            : { data: block.data, mediaType: block.mimeType, type: "image" },
    );
    const display =
        content
            .filter(
                (block): block is Extract<SessionOutputBlock, { type: "text" }> =>
                    block.type === "text",
            )
            .map((block) => block.text)
            .join("") || (isError === true ? "Tool failed." : "Tool completed.");
    return {
        result: {
            display,
            ...(isError === true ? { isError: true } : {}),
            rendered,
            toolCallId: callId,
            toolName,
            type: "tool_result",
        },
        type: "tool_execution_end",
    };
}

function requireActive(run: ActiveRun, kind: ActiveRun["activeKind"]): number {
    if (run.activeIndex === null || run.activeKind !== kind) {
        throw new Error(`The provider emitted a ${kind ?? "stream"} delta without a start event.`);
    }
    return run.activeIndex;
}

function partialMessage(run: ActiveRun, now: number): UnknownRecord {
    return {
        api: "happy-agent",
        content: run.blocks,
        model: "current",
        provider: "happy-agent",
        role: "assistant",
        stopReason: run.stopReason,
        timestamp: now,
        usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    };
}

function parseToolArguments(value: string): UnknownRecord {
    try {
        const parsed: unknown = JSON.parse(value);
        return recordValue(parsed) ?? { value: parsed };
    } catch {
        return { raw: value };
    }
}

function recordValue(value: unknown): UnknownRecord | undefined {
    return Value.Check(unknownRecordSchema, value) ? value : undefined;
}

function snapshotPayload(payload: unknown): unknown {
    return structuredClone(payload);
}

function freezeEvent(event: HappyAgentEvent): HappyAgentEvent {
    deepFreeze(event);
    return event;
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
}
