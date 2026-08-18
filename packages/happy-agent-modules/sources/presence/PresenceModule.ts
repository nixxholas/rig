import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    BUILT_IN_PRESENCES,
    ONLINE_PRESENCE_ID,
    assertPresenceCatalog,
    isBuiltInPresenceId,
} from "./PresenceCatalog.js";
import { createPresenceDatabase, presenceMigrations } from "./PresenceDatabase.js";
import {
    presenceContextSchema,
    presenceEventSchema,
    presenceModuleListenerSchema,
    type PresenceEvent,
} from "./PresenceEvent.js";
import {
    presenceUserInputChangeCallbackSchema,
    type PresenceUserInputChangeCallback,
    type PresenceUserInputPolicy,
} from "./PresencePolicy.js";
import {
    assertPresenceSchedule,
    assertPresenceScheduleInput,
    presenceScheduleSchema,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./PresenceSchedule.js";
import {
    assertPresenceDefinition,
    assertPresenceMutationInput,
    assertPresenceState,
    assertPresenceStoredState,
    assertPresenceToolInput,
    assertPresenceUserInputState,
    assertTemporaryPresenceInput,
    presenceCatalogInputSchema,
    presenceReferenceSchema,
    presenceStoredStateSchema,
    presenceToolInputSchema,
    type PresenceDefinition,
    type PresenceMutationInput,
    type PresenceState,
    type PresenceStoredState,
    type PresenceToolInput,
    type PresenceUserInputState,
    type TemporaryPresenceInput,
} from "./PresenceState.js";
import {
    assertPresenceDefinitionResult,
    assertPresenceScheduleResult,
    assertPresenceStateResult,
    type PresenceReader,
    type PresenceScheduleStore,
    type PresenceStore,
} from "./PresenceStore.js";
import { getPresenceTool } from "./tools/get_presence.js";
import { listPresenceTool } from "./tools/list_presence.js";
import { setPresenceTool } from "./tools/set_presence.js";

const scheduleIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const nonNegativeIntegerSchema = Type.Integer({
    minimum: 0,
    maximum: 8_640_000_000_000_000,
});
const maxCatalogEntriesSchema = Type.Integer({ minimum: 1, maximum: 256 });
const voidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

export const presenceModuleOptionsSchema = Type.Object(
    {
        clock: Type.Optional(Type.Function([], nonNegativeIntegerSchema)),
        listener: Type.Optional(presenceModuleListenerSchema),
        allowModelMutation: Type.Optional(Type.Boolean()),
        catalog: Type.Optional(presenceCatalogInputSchema),
        initialState: Type.Optional(presenceStoredStateSchema),
        maxSchedules: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
        maxPresences: Type.Optional(maxCatalogEntriesSchema),
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
 * One shared, host-configured presence capability for every agent.
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
    readonly #maxPresences: number;
    readonly #configuredCatalog: readonly PresenceDefinition[];
    readonly #initialState: PresenceModuleOptions["initialState"];
    readonly #onPostCommitError: PresenceModuleOptions["onPostCommitError"];
    readonly #userInputSubscribers = new Set<PresenceUserInputChangeCallback>();
    readonly userInputPolicy: PresenceUserInputPolicy;

    constructor(options: PresenceModuleOptions = {}) {
        const validated = validateOptions(options);
        this.#store = createPresenceDatabase();
        this.#clock = validated.clock ?? Date.now;
        this.#listener = validated.listener;
        this.#allowModelMutation = validated.allowModelMutation ?? false;
        this.#maxSchedules = validated.maxSchedules ?? 64;
        this.#maxPresences = validated.maxPresences ?? 64;
        this.#configuredCatalog = cloneCatalog(validated.catalog ?? []);
        this.#initialState =
            validated.initialState === undefined ? undefined : cloneValue(validated.initialState);
        this.#onPostCommitError = validated.onPostCommitError;
        this.userInputPolicy = {
            state: async (ctx, _agentId) => await this.userInputState(ctx),
            subscribe: async (ctx, _agentId, callback) =>
                await this.subscribeUserInput(ctx, callback),
        };
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const initialState = this.#initialState;
        if (initialState === undefined) return this.#hooks;
        await ctx.inTx(async (txCtx) => {
            const existing = await this.#readConfigured(txCtx);
            if (existing === undefined) {
                const catalog = await this.#readCatalog(txCtx);
                const normalized =
                    initialState.expiresAt === undefined ||
                    initialState.fallbackPresenceId !== undefined
                        ? initialState
                        : {
                              ...initialState,
                              fallbackPresenceId: ONLINE_PRESENCE_ID,
                          };
                assertCatalogSelection(normalized, catalog);
                await this.#store.set(txCtx, cloneValue(normalized));
            }
        });
        return this.#hooks;
    };

    /** Read the host-resolved effective presence at the injected clock instant. */
    async read(ctx: Context): Promise<PresenceState | undefined> {
        const value = await this.#store.read(ctx, this.#now());
        if (value === undefined) return undefined;
        assertPresenceStoredState(value);
        const catalog = await this.#readCatalog(ctx);
        const state = materializeStoredState(value, catalog);
        assertPresenceState(state);
        return cloneValue(state);
    }

    /** Alias that reads the same effective state, useful to non-agent host callers. */
    async state(ctx: Context): Promise<PresenceState | undefined> {
        return await this.read(ctx);
    }

    /**
     * Return the narrow, display-ready presence projection consumed by UserInput through
     * `userInputPolicy`. The projection intentionally excludes the catalog and user message.
     */
    async userInputState(ctx: Context): Promise<PresenceUserInputState | undefined> {
        const current = await this.read(ctx);
        if (current === undefined) return undefined;
        return cloneValue(toUserInputState(current));
    }

    /**
     * Subscribe to effective-state changes for a bounded external wait. This set is only
     * ephemeral observation state; durable presence remains in the module database.
     */
    async subscribeUserInput(
        ctx: Context,
        callback: PresenceUserInputChangeCallback,
    ): Promise<() => void> {
        if (!Value.Check(presenceUserInputChangeCallbackSchema, callback)) {
            throw new Error("Presence user-input callback is invalid.");
        }
        this.#userInputSubscribers.add(callback);
        try {
            await invokeVoid(
                callback(ctx, cloneValue(await this.userInputState(ctx))),
                "Presence user-input callback",
            );
        } catch (error: unknown) {
            this.#userInputSubscribers.delete(callback);
            throw error;
        }
        return () => {
            this.#userInputSubscribers.delete(callback);
        };
    }

    async setPresence(
        ctx: Context,
        input: PresenceMutationInput | PresenceToolInput,
    ): Promise<PresenceState> {
        const requested = normalizeMutationInput(input, this.#now());
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            assertCatalogSelection(requested, catalog);
            const previous = await this.#readConfigured(txCtx);
            if (previous !== undefined && sameStoredState(previous, requested)) {
                return {
                    result: materializeStoredState(requested, catalog),
                };
            }

            await this.#store.set(txCtx, cloneValue(requested));
            return {
                result: materializeStoredState(requested, catalog),
                event: {
                    type: "presence_changed",
                    eventId,
                    at,
                    previous:
                        previous === undefined ? null : materializeStoredState(previous, catalog),
                    current: materializeStoredState(requested, catalog),
                },
            };
        });
        assertPresenceStateResult(result);
        return cloneValue(result);
    }

    /** Remove the configured presence, returning false when there was nothing to clear. */
    async clear(ctx: Context): Promise<boolean> {
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            const previous = await this.#readConfigured(txCtx);
            if (previous === undefined) return { result: false };

            await this.#store.clear(txCtx);
            return {
                result: true,
                event: {
                    type: "presence_cleared",
                    eventId,
                    at,
                    previous: materializeStoredState(previous, catalog),
                },
            };
        });
        return result;
    }

    /** Set a temporary value; expiration and fallback are interpreted by the database. */
    async setTemporary(ctx: Context, input: TemporaryPresenceInput): Promise<PresenceState> {
        assertTemporaryPresenceInput(input);
        return await this.setPresence(ctx, {
            ...input,
            effectiveFrom: input.effectiveFrom ?? this.#now(),
        });
    }

    /** List the built-in and configured custom presence definitions in a bounded catalog. */
    async listPresences(ctx: Context): Promise<readonly PresenceDefinition[]> {
        return cloneCatalog(await this.#readCatalog(ctx));
    }

    /** Persist one custom definition so it is available after a fresh module instance. */
    async setPresenceDefinition(
        ctx: Context,
        definition: PresenceDefinition,
    ): Promise<PresenceDefinition> {
        assertPresenceDefinition(definition);
        if (isBuiltInPresenceId(definition.id)) {
            throw new Error("Built-in presence definitions cannot be replaced.");
        }
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            const existing = catalog.find((candidate) => candidate.id === definition.id);
            if (existing !== undefined && sameDefinition(existing, definition)) {
                return { result: cloneValue(existing) };
            }
            if (existing === undefined && catalog.length >= this.#maxPresences) {
                throw new Error("Presence catalog limit reached.");
            }
            const stored = await this.#store.catalog.set(txCtx, cloneValue(definition));
            assertPresenceDefinitionResult(stored);
            if (!sameDefinition(stored, definition)) {
                throw new Error("Presence database returned a different definition.");
            }
            return {
                result: cloneValue(stored),
                event: {
                    type: "presence_definition_set",
                    eventId,
                    at,
                    definition: cloneValue(stored),
                },
            };
        });
        assertPresenceDefinitionResult(result);
        return cloneValue(result);
    }

    /** Remove one persisted custom definition; configured and built-in definitions are fixed. */
    async clearPresenceDefinition(ctx: Context, presenceId: string): Promise<boolean> {
        if (!Value.Check(scheduleIdSchema, presenceId)) {
            throw new Error("Presence ID is invalid.");
        }
        if (
            isBuiltInPresenceId(presenceId) ||
            this.#configuredCatalog.some((candidate) => candidate.id === presenceId)
        ) {
            throw new Error("Configured presence definitions cannot be cleared.");
        }
        return await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const current = await this.#readConfigured(txCtx);
            if (current?.presenceId === presenceId) {
                throw new Error("The active presence definition cannot be cleared.");
            }
            if (current?.fallbackPresenceId === presenceId) {
                throw new Error(
                    "This presence is the fallback of the current presence and cannot be cleared.",
                );
            }
            const schedules = await this.#readSchedules(
                txCtx,
                this.#scheduleStore(),
                this.#maxSchedules,
            );
            if (schedules.some((candidate) => referenceId(candidate.presence) === presenceId)) {
                throw new Error("This presence is used by a schedule and cannot be cleared.");
            }
            const removed = await this.#store.catalog.clear(txCtx, presenceId);
            return {
                result: removed,
                ...(removed
                    ? {
                          event: {
                              type: "presence_definition_cleared" as const,
                              eventId,
                              at,
                              presenceId,
                          },
                      }
                    : {}),
            };
        });
    }

    async listSchedules(ctx: Context): Promise<readonly PresenceSchedule[]> {
        const scheduleStore = this.#scheduleStore();
        return await this.#readSchedules(ctx, scheduleStore, this.#maxSchedules);
    }

    async setSchedule(ctx: Context, input: PresenceScheduleInput): Promise<PresenceSchedule> {
        assertPresenceScheduleInput(input);
        assertKnownTimeZone(input.timeZone);
        const scheduleStore = this.#scheduleStore();
        const requested = normalizeScheduleInput(input);
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            assertCatalogReference(requested.presence, catalog);
            const existing = await this.#readSchedules(txCtx, scheduleStore, this.#maxSchedules);
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

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, _scope: AgentModuleScope): Promise<string> => {
            const current = await this.read(ctx);
            return current === undefined ? "" : formatPresenceInstruction(current);
        },

        tools: (_ctx: Context, _scope: AgentModuleScope): readonly AnyAgentTool[] => {
            const tools: AnyAgentTool[] = [getPresenceTool(this), listPresenceTool(this)];
            if (this.#allowModelMutation) tools.push(setPresenceTool(this));
            return tools;
        },
    };

    async #mutate<Result>(
        ctx: Context,
        decide: (txCtx: Context, eventId: string, at: number) => Promise<PresenceChange<Result>>,
    ): Promise<Result> {
        const eventId = globalThis.crypto.randomUUID();
        const at = this.#now();
        return await ctx.inTx(async (txCtx) => {
            const decided = await decide(txCtx, eventId, at);
            const event =
                decided.event === undefined ? undefined : cloneAndFreezeEvent(decided.event);
            if (event !== undefined) {
                const userInputState = await this.#readUserInputState(txCtx, at);
                await invokeVoid(
                    this.#listener?.onEventTransactional?.(txCtx, event),
                    "Presence transactional listener",
                );
                afterCommit(txCtx, (postCommitCtx) =>
                    this.#notifyPostCommit(postCommitCtx, event, userInputState),
                );
            }
            return cloneValue(decided.result);
        });
    }

    async #readConfigured(ctx: Context): Promise<PresenceStoredState | undefined> {
        const previous = await this.#store.readConfigured(ctx);
        if (previous !== undefined) assertPresenceStoredState(previous);
        return previous === undefined ? undefined : cloneValue(previous);
    }

    async #readCatalog(ctx: Context): Promise<readonly PresenceDefinition[]> {
        const stored = await this.#store.catalog.list(ctx, {
            limit: this.#maxPresences + 1,
        });
        if (stored.length > this.#maxPresences) {
            throw new Error("Presence database returned more definitions than requested.");
        }
        const byId = new Map<string, PresenceDefinition>();
        for (const definition of BUILT_IN_PRESENCES) byId.set(definition.id, definition);
        for (const definition of this.#configuredCatalog) byId.set(definition.id, definition);
        for (const definition of stored) {
            assertPresenceDefinitionResult(definition);
            byId.set(definition.id, definition);
        }
        if (byId.size > this.#maxPresences) {
            throw new Error("Presence catalog exceeds its configured bound.");
        }
        return [...byId.values()].map((definition) => cloneValue(definition));
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

    async #readUserInputState(
        ctx: Context,
        at: number,
    ): Promise<PresenceUserInputState | undefined> {
        const stored = await this.#store.read(ctx, at);
        if (stored === undefined) return undefined;
        assertPresenceStoredState(stored);
        const catalog = await this.#readCatalog(ctx);
        return toUserInputState(materializeStoredState(stored, catalog));
    }

    async #notifyPostCommit(
        ctx: Context,
        event: PresenceEvent,
        current: PresenceUserInputState | undefined,
    ): Promise<void> {
        try {
            await invokeVoid(
                this.#listener?.onEvent?.(ctx, event),
                "Presence post-commit listener",
            );
        } catch (error: unknown) {
            await this.#reportPostCommitError(ctx, event, error);
        }

        for (const callback of this.#userInputSubscribers) {
            try {
                await invokeVoid(
                    callback(ctx, cloneValue(current)),
                    "Presence user-input callback",
                );
            } catch (error: unknown) {
                await this.#reportPostCommitError(ctx, event, error);
            }
        }
    }

    async #reportPostCommitError(
        ctx: Context,
        event: PresenceEvent,
        error: unknown,
    ): Promise<void> {
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

function validateOptions(options: unknown): PresenceModuleOptions {
    if (!Value.Check(presenceModuleOptionsSchema, options)) {
        throw new Error("Presence module options contain unknown or invalid keys.");
    }
    const catalog = options.catalog ?? [];
    if (options.catalog !== undefined) {
        assertPresenceCatalog(options.catalog);
        for (const definition of options.catalog) {
            if (isBuiltInPresenceId(definition.id)) {
                throw new Error("Built-in presence definitions cannot be replaced.");
            }
        }
    }
    const maxPresences = options.maxPresences ?? 64;
    if (maxPresences < BUILT_IN_PRESENCES.length + catalog.length) {
        throw new Error(
            "The presence catalog limit is too small to hold the built-in and configured presences.",
        );
    }
    return options as PresenceModuleOptions;
}

/**
 * Reject a time zone the runtime cannot interpret before it reaches durable storage, so schedule
 * evaluation never depends on a value that will throw later.
 */
function assertKnownTimeZone(timeZone: string): void {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
        throw new Error(`"${timeZone}" is not a time zone this system recognizes.`);
    }
}

function normalizeMutationInput(
    input: PresenceMutationInput | PresenceToolInput,
    now: number,
): PresenceStoredState {
    let presenceId: string;
    let message: string | undefined;
    let effectiveFrom: number | undefined;
    let expiresAt: number | undefined;
    let fallbackPresenceId: string | undefined;
    let fallback: PresenceMutationInput["fallback"];

    if (Value.Check(presenceToolInputSchema, input)) {
        assertPresenceToolInput(input);
        presenceId = "presenceId" in input ? input.presenceId : input.status;
        message = input.message;
        expiresAt = input.until;
        fallbackPresenceId = input.fallbackPresenceId;
    } else {
        assertPresenceMutationInput(input);
        presenceId = "presenceId" in input ? input.presenceId : input.status;
        message = input.message;
        effectiveFrom = input.effectiveFrom;
        expiresAt = input.expiresAt;
        fallbackPresenceId = input.fallbackPresenceId;
        fallback = input.fallback;
    }
    if (fallback !== undefined) {
        if (!Value.Check(presenceReferenceSchema, fallback)) {
            throw new Error("Presence fallback is invalid.");
        }
        const referenceId = "presenceId" in fallback ? fallback.presenceId : fallback.status;
        if (referenceId === undefined) throw new Error("Presence fallback is invalid.");
        if (fallbackPresenceId !== undefined && fallbackPresenceId !== referenceId) {
            throw new Error("Presence fallback IDs disagree.");
        }
        fallbackPresenceId = referenceId;
    }
    if (expiresAt !== undefined) {
        effectiveFrom ??= now;
        fallbackPresenceId ??= ONLINE_PRESENCE_ID;
    }
    const result = {
        presenceId,
        ...(message === undefined ? {} : { message }),
        ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(fallbackPresenceId === undefined ? {} : { fallbackPresenceId }),
    };
    assertPresenceStoredState(result);
    if (expiresAt !== undefined && expiresAt <= now) {
        throw new Error("A presence must expire in the future.");
    }
    return result;
}

function assertCatalogSelection(
    selection: PresenceStoredState,
    catalog: readonly PresenceDefinition[],
): void {
    const definition = catalog.find((candidate) => candidate.id === selection.presenceId);
    if (definition === undefined) {
        throw new Error(`There is no presence called "${selection.presenceId}".`);
    }
    if (
        selection.fallbackPresenceId !== undefined &&
        !catalog.some((candidate) => candidate.id === selection.fallbackPresenceId)
    ) {
        throw new Error(`There is no presence called "${selection.fallbackPresenceId}".`);
    }
}

/** The catalog identity a schedule or fallback reference points at, in either reference form. */
function referenceId(reference: PresenceSchedule["presence"]): string {
    return "presenceId" in reference ? reference.presenceId : reference.status;
}

function assertCatalogReference(
    reference: PresenceSchedule["presence"],
    catalog: readonly PresenceDefinition[],
): void {
    const id = referenceId(reference);
    if (!catalog.some((candidate) => candidate.id === id)) {
        throw new Error(`There is no presence called "${id}".`);
    }
    if ("status" in reference && reference.status === "custom" && reference.presenceId !== id) {
        throw new Error("Custom presence reference identity is inconsistent.");
    }
}

function materializeStoredState(
    stored: PresenceStoredState,
    catalog: readonly PresenceDefinition[],
): PresenceState {
    const definition = catalog.find((candidate) => candidate.id === stored.presenceId);
    if (definition === undefined) {
        throw new Error(`Presence definition "${stored.presenceId}" is not configured.`);
    }
    const fallback =
        stored.fallbackPresenceId === undefined
            ? undefined
            : { presenceId: stored.fallbackPresenceId };
    const result = {
        presenceId: definition.id,
        status: definition.status,
        title: definition.title,
        emoji: definition.emoji,
        prompt: definition.prompt,
        answerWaitMs: definition.answerWaitMs,
        ...(stored.message === undefined ? {} : { message: stored.message }),
        ...(stored.effectiveFrom === undefined ? {} : { effectiveFrom: stored.effectiveFrom }),
        ...(stored.expiresAt === undefined
            ? {}
            : { expiresAt: stored.expiresAt, changesAt: stored.expiresAt }),
        ...(stored.fallbackPresenceId === undefined
            ? {}
            : {
                  fallbackPresenceId: stored.fallbackPresenceId,
                  fallback,
              }),
    };
    assertPresenceState(result);
    return result;
}

function toUserInputState(state: PresenceState): PresenceUserInputState {
    const result = {
        answerWaitMs: state.answerWaitMs,
        title: state.title,
        emoji: state.emoji,
        prompt: state.prompt,
        ...(state.expiresAt === undefined ? {} : { changesAt: state.expiresAt }),
    };
    assertPresenceUserInputState(result);
    return result;
}

function sameStoredState(left: PresenceStoredState, right: PresenceStoredState): boolean {
    return (
        left.presenceId === right.presenceId &&
        left.message === right.message &&
        left.effectiveFrom === right.effectiveFrom &&
        left.expiresAt === right.expiresAt &&
        left.fallbackPresenceId === right.fallbackPresenceId
    );
}

function sameDefinition(left: PresenceDefinition, right: PresenceDefinition): boolean {
    return (
        left.id === right.id &&
        left.status === right.status &&
        left.title === right.title &&
        left.emoji === right.emoji &&
        left.prompt === right.prompt &&
        left.answerWaitMs === right.answerWaitMs
    );
}

function normalizeScheduleInput(input: PresenceScheduleInput): PresenceScheduleInput {
    return {
        days: [...input.days].sort((left, right) => left - right),
        startTime: input.startTime,
        endTime: input.endTime,
        timeZone: input.timeZone,
        presence: normalizeReference(input.presence),
    };
}

function normalizeReference(
    reference: PresenceScheduleInput["presence"],
): PresenceScheduleInput["presence"] {
    if ("presenceId" in reference) {
        return {
            presenceId: reference.presenceId,
            ...(reference.message === undefined ? {} : { message: reference.message }),
        };
    }
    return {
        status: reference.status,
        ...(reference.message === undefined ? {} : { message: reference.message }),
    };
}

function assertCanonicalSchedule(schedule: PresenceSchedule): void {
    const canonicalDays = [...schedule.days].sort((left, right) => left - right);
    if (!schedule.days.every((day, index) => day === canonicalDays[index])) {
        throw new Error("Presence schedule days must use canonical ascending order.");
    }
}

function sameSchedule(stored: PresenceSchedule, requested: PresenceScheduleInput): boolean {
    const normalized = normalizeScheduleInput(requested);
    return (
        stored.days.length === normalized.days.length &&
        stored.days.every((day, index) => day === normalized.days[index]) &&
        stored.startTime === normalized.startTime &&
        stored.endTime === normalized.endTime &&
        stored.timeZone === normalized.timeZone &&
        sameReference(stored.presence, normalized.presence)
    );
}

function sameReference(
    left: PresenceSchedule["presence"],
    right: PresenceScheduleInput["presence"],
): boolean {
    const leftId = "presenceId" in left ? left.presenceId : left.status;
    const rightId = "presenceId" in right ? right.presenceId : right.status;
    return leftId === rightId && left.message === right.message;
}

function cloneCatalog(catalog: readonly PresenceDefinition[]): readonly PresenceDefinition[] {
    return catalog.map((definition) => cloneValue(definition));
}

/** Format the full model-facing guidance for the current effective state. */
export function formatPresenceInstruction(state: PresenceState): string {
    assertPresenceState(state);
    const identity = `${state.title} ${state.emoji}`.trim();
    const message =
        state.message === undefined ? "" : ` The user's status message is: ${state.message}.`;
    const prompt = state.prompt.trim();
    return `Current user presence: ${identity}.${message}${prompt.length === 0 ? "" : ` ${prompt}`}`;
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

async function invokeVoid(value: void | Promise<void> | undefined, label: string): Promise<void> {
    const resolved = await value;
    if (resolved !== undefined) {
        throw new Error(`${label} must return undefined.`);
    }
}
