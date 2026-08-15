import {
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { createPresenceDatabase, presenceMigrations } from "./PresenceDatabase.js";
import {
    presenceContextSchema,
    presenceEventSchema,
    presenceModuleListenerSchema,
    type PresenceEvent,
} from "./PresenceEvent.js";
import {
    assertPresenceSchedule,
    assertPresenceScheduleInput,
    presenceScheduleSchema,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./PresenceSchedule.js";
import {
    assertPresenceState,
    assertTemporaryPresenceInput,
    type PresenceState,
    type PresenceToolInput,
    type TemporaryPresenceInput,
} from "./PresenceState.js";
import {
    assertPresenceScheduleResult,
    assertPresenceStateResult,
    type PresenceReader,
    type PresenceScheduleStore,
    type PresenceStore,
} from "./PresenceStore.js";
import { getPresenceTool } from "./tools/get_presence.js";
import { setPresenceTool } from "./tools/set_presence.js";

const scheduleIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const nonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const voidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
export const presenceModuleOptionsSchema = Type.Object(
    {
        clock: Type.Optional(Type.Function([], nonNegativeIntegerSchema)),
        listener: Type.Optional(presenceModuleListenerSchema),
        allowModelMutation: Type.Optional(Type.Boolean()),
        maxSchedules: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
        onPostCommitError: Type.Optional(
            Type.Function(
                [presenceContextSchema, presenceEventSchema, Type.Unknown()],
                voidOrPromiseVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export type PresenceModuleOptions = Static<typeof presenceModuleOptionsSchema>;

type PresenceChange<Result> = {
    readonly result: Result;
    readonly event?: PresenceEvent;
};

/**
 * One shared, host-configured presence capability for every agent in a system.
 *
 * Agent Base owns durable tool settlement. Presence owns only its domain state, validation,
 * transactions, and event semantics; it keeps no operation identities or replay ledger.
 */
export class PresenceModule implements AgentModule, PresenceReader {
    readonly name = "presence";
    readonly migrations = presenceMigrations;
    readonly #store: PresenceStore;
    readonly #clock: NonNullable<PresenceModuleOptions["clock"]>;
    readonly #listener: PresenceModuleOptions["listener"];
    readonly #allowModelMutation: boolean;
    readonly #maxSchedules: number;
    readonly #onPostCommitError: PresenceModuleOptions["onPostCommitError"];

    constructor(options: PresenceModuleOptions = {}) {
        const validated = validateOptions(options);
        this.#store = createPresenceDatabase();
        this.#clock = validated.clock ?? Date.now;
        this.#listener = validated.listener;
        this.#allowModelMutation = validated.allowModelMutation ?? false;
        this.#maxSchedules = validated.maxSchedules ?? 64;
        this.#onPostCommitError = validated.onPostCommitError;
    }

    /** Read the host-resolved effective presence at the injected clock instant. */
    async read(ctx: Context): Promise<PresenceState | undefined> {
        const value = await this.#store.read(ctx, this.#now());
        if (value !== undefined) assertPresenceState(value);
        return value === undefined ? undefined : cloneValue(value);
    }

    /** Alias that reads the same effective state, useful to non-agent host callers. */
    async state(ctx: Context): Promise<PresenceState | undefined> {
        return await this.read(ctx);
    }

    async setPresence(
        ctx: Context,
        input: PresenceState | PresenceToolInput,
    ): Promise<PresenceState> {
        assertPresenceState(input);
        const requested = normalizePresenceState(input);
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const previous = await this.#readConfigured(txCtx);
            if (previous !== undefined && samePresenceState(previous, requested)) {
                return { result: cloneValue(requested) };
            }

            await this.#store.set(txCtx, cloneValue(requested));
            return {
                result: cloneValue(requested),
                event: {
                    type: "presence_changed",
                    eventId,
                    at,
                    previous: previous === undefined ? null : cloneValue(previous),
                    current: cloneValue(requested),
                },
            };
        });
        assertPresenceStateResult(result);
        return cloneValue(result);
    }

    /** Remove the configured presence, returning false when there was nothing to clear. */
    async clear(ctx: Context): Promise<boolean> {
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const previous = await this.#readConfigured(txCtx);
            if (previous === undefined) return { result: false };

            await this.#store.clear(txCtx);
            return {
                result: true,
                event: {
                    type: "presence_cleared",
                    eventId,
                    at,
                    previous: cloneValue(previous),
                },
            };
        });
        return result;
    }

    /** Set a temporary value; expiration and fallback are interpreted by the database. */
    async setTemporary(
        ctx: Context,
        input: TemporaryPresenceInput,
    ): Promise<PresenceState> {
        assertTemporaryPresenceInput(input);
        return await this.setPresence(
            ctx,
            normalizePresenceState({
                status: input.status,
                ...(input.message === undefined ? {} : { message: input.message }),
                effectiveFrom: input.effectiveFrom ?? this.#now(),
                expiresAt: input.expiresAt,
                ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
            } as PresenceState),
        );
    }

    async listSchedules(ctx: Context): Promise<readonly PresenceSchedule[]> {
        const scheduleStore = this.#scheduleStore();
        return await this.#readSchedules(ctx, scheduleStore, this.#maxSchedules);
    }

    async setSchedule(
        ctx: Context,
        input: PresenceScheduleInput,
    ): Promise<PresenceSchedule> {
        assertPresenceScheduleInput(input);
        const scheduleStore = this.#scheduleStore();
        const requested = normalizeScheduleInput(input);
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const existing = await this.#readSchedules(
                txCtx,
                scheduleStore,
                this.#maxSchedules,
            );
            const duplicate = existing.find((candidate) => sameSchedule(candidate, requested));
            if (duplicate !== undefined) {
                return { result: cloneValue(duplicate) };
            }
            if (existing.length >= this.#maxSchedules) {
                throw new Error("Presence schedule limit reached.");
            }

            const stored = await scheduleStore.set(
                txCtx,
                cloneValue(requested),
                globalThis.crypto.randomUUID(),
            );
            assertPresenceScheduleResult(stored);
            assertCanonicalSchedule(stored);
            if (!sameSchedule(stored, requested)) {
                throw new Error("Presence database returned a different schedule.");
            }
            if (existing.some((candidate) => candidate.id === stored.id)) {
                throw new Error("Presence database returned a colliding schedule ID.");
            }
            return {
                result: cloneValue(stored),
                event: {
                    type: "presence_schedule_set",
                    eventId,
                    at,
                    schedule: cloneValue(stored),
                },
            };
        });
        assertPresenceScheduleResult(result);
        return cloneValue(result);
    }

    async clearSchedule(ctx: Context, scheduleId: string): Promise<boolean> {
        if (!Value.Check(scheduleIdSchema, scheduleId)) {
            throw new Error("Presence schedule ID is invalid.");
        }
        const scheduleStore = this.#scheduleStore();
        return await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const removed = await scheduleStore.clear(txCtx, scheduleId);
            return {
                result: removed,
                ...(removed
                    ? {
                          event: {
                              type: "presence_schedule_cleared" as const,
                              eventId,
                              at,
                              scheduleId,
                          },
                      }
                    : {}),
            };
        });
    }

    readonly instructions = async (ctx: Context, _scope: AgentModuleScope): Promise<string> => {
        const current = await this.read(ctx);
        if (current === undefined) return "";
        return formatPresenceInstruction(current);
    };

    readonly tools = (_ctx: Context, _scope: AgentModuleScope): readonly AnyAgentTool[] => {
        const tools: AnyAgentTool[] = [getPresenceTool(this)];
        if (this.#allowModelMutation) tools.push(setPresenceTool(this));
        return tools;
    };

    async #mutate<Result>(
        ctx: Context,
        decide: (
            txCtx: Context,
            eventId: string,
            at: number,
        ) => Promise<PresenceChange<Result>>,
    ): Promise<Result> {
        const eventId = globalThis.crypto.randomUUID();
        const at = this.#now();
        return await ctx.inTx(async (txCtx) => {
            const decided = await decide(txCtx, eventId, at);
            const event =
                decided.event === undefined ? undefined : cloneAndFreezeEvent(decided.event);
            if (event !== undefined) {
                await invokeVoid(
                    this.#listener?.onEventTransactional?.(txCtx, event),
                    "Presence transactional listener",
                );
                afterCommit(txCtx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
            }
            return cloneValue(decided.result);
        });
    }

    async #readConfigured(ctx: Context): Promise<PresenceState | undefined> {
        const previous = await this.#store.readConfigured(ctx);
        if (previous !== undefined) assertPresenceState(previous);
        return previous === undefined ? undefined : cloneValue(previous);
    }

    #scheduleStore(): PresenceScheduleStore {
        return this.#store.schedules;
    }

    async #readSchedules(
        ctx: Context,
        scheduleStore: PresenceScheduleStore,
        limit: number,
    ): Promise<readonly PresenceSchedule[]> {
        const schedules = await scheduleStore.list(ctx, { limit });
        if (!Value.Check(Type.Array(presenceScheduleSchema, { maxItems: 10_000 }), schedules)) {
            throw new Error("Presence database returned an invalid schedule list.");
        }
        if (schedules.length > limit) {
            throw new Error("Presence database returned more schedules than requested.");
        }

        const ids = new Set<string>();
        const cloned: PresenceSchedule[] = [];
        for (const schedule of schedules) {
            assertPresenceSchedule(schedule);
            assertCanonicalSchedule(schedule);
            if (ids.has(schedule.id)) {
                throw new Error("Presence database returned duplicate schedule IDs.");
            }
            ids.add(schedule.id);
            cloned.push(cloneValue(schedule));
        }
        return cloned;
    }

    #now(): number {
        const now = this.#clock();
        if (!Value.Check(nonNegativeIntegerSchema, now)) {
            throw new Error("Presence clock must return a non-negative integer.");
        }
        return now;
    }

    async #notifyPostCommit(ctx: Context, event: PresenceEvent): Promise<void> {
        try {
            await invokeVoid(
                this.#listener?.onEvent?.(ctx, event),
                "Presence post-commit listener",
            );
        } catch (error: unknown) {
            try {
                await invokeVoid(
                    this.#onPostCommitError?.(ctx, event, error),
                    "Presence post-commit error handler",
                );
            } catch {
                // Reporting is advisory and must not turn a committed mutation into a failure.
            }
        }
    }
}

function validateOptions(options: unknown): PresenceModuleOptions {
    if (!Value.Check(presenceModuleOptionsSchema, options)) {
        throw new Error("Presence module options contain unknown or invalid keys.");
    }
    return options as PresenceModuleOptions;
}

function normalizePresenceState(state: PresenceState): PresenceState {
    return {
        status: state.status,
        ...(state.message === undefined ? {} : { message: state.message }),
        ...(state.effectiveFrom === undefined ? {} : { effectiveFrom: state.effectiveFrom }),
        ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
        ...(state.fallback === undefined
            ? {}
            : {
                  fallback: {
                      status: state.fallback.status,
                      ...(state.fallback.message === undefined
                          ? {}
                          : { message: state.fallback.message }),
                  },
              }),
    } as PresenceState;
}

function samePresenceState(left: PresenceState, right: PresenceState): boolean {
    return (
        left.status === right.status &&
        left.message === right.message &&
        left.effectiveFrom === right.effectiveFrom &&
        left.expiresAt === right.expiresAt &&
        ((left.fallback === undefined && right.fallback === undefined) ||
            (left.fallback !== undefined &&
                right.fallback !== undefined &&
                left.fallback.status === right.fallback.status &&
                left.fallback.message === right.fallback.message))
    );
}

function normalizeScheduleInput(input: PresenceScheduleInput): PresenceScheduleInput {
    return {
        days: [...input.days].sort((left, right) => left - right),
        startTime: input.startTime,
        endTime: input.endTime,
        timeZone: input.timeZone,
        presence: normalizeFallback(input.presence),
    };
}

function assertCanonicalSchedule(schedule: PresenceSchedule): void {
    const canonicalDays = [...schedule.days].sort((left, right) => left - right);
    if (!schedule.days.every((day, index) => day === canonicalDays[index])) {
        throw new Error("Presence schedule days must use canonical ascending order.");
    }
}

function normalizeFallback(
    fallback: PresenceState["fallback"],
): NonNullable<PresenceState["fallback"]> {
    if (fallback === undefined) {
        throw new Error("Presence schedule fallback is required.");
    }
    return {
        status: fallback.status,
        ...(fallback.message === undefined ? {} : { message: fallback.message }),
    } as NonNullable<PresenceState["fallback"]>;
}

function sameSchedule(stored: PresenceSchedule, requested: PresenceScheduleInput): boolean {
    const normalized = normalizeScheduleInput(requested);
    return (
        stored.days.length === normalized.days.length &&
        stored.days.every((day, index) => day === normalized.days[index]) &&
        stored.startTime === normalized.startTime &&
        stored.endTime === normalized.endTime &&
        stored.timeZone === normalized.timeZone &&
        stored.presence.status === normalized.presence.status &&
        stored.presence.message === normalized.presence.message
    );
}

function formatPresenceInstruction(state: PresenceState): string {
    const label =
        state.status === "dnd"
            ? "do not disturb"
            : state.status === "custom"
              ? "custom"
              : state.status;
    return state.message === undefined
        ? `Current user presence: ${label}.`
        : `Current user presence: ${label} — ${state.message}.`;
}

function cloneAndFreezeEvent(event: PresenceEvent): PresenceEvent {
    if (!Value.Check(presenceEventSchema, event)) {
        throw new Error("Presence module created an invalid event.");
    }
    return deepFreeze(cloneValue(event));
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

async function invokeVoid(
    value: void | Promise<void> | undefined,
    label: string,
): Promise<void> {
    const resolved = await value;
    if (resolved !== undefined) {
        throw new Error(`${label} must return undefined.`);
    }
}
