import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import {
    agentId as agentRunningInside,
    agentDatabaseRun,
    type AgentBaseInference,
    type AgentBaseTurn,
    type AgentModule,
    type AgentModuleAgentLifecycle,
    type AgentModuleAction,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    goalEventSchema,
    goalModuleListenerSchema,
    goalContextSchema,
    goalVoidOrPromiseVoidSchema,
    type GoalEvent,
    type GoalModuleListener,
} from "./GoalEvent.js";
import { AGENT_MESSAGE_ORIGIN_METADATA, senderAgentIdMetadata } from "../auto/messageOrigin.js";
import { createGoalContinuationPrompt } from "./impl/createGoalContinuationPrompt.js";
import { createGoalTitle } from "./impl/createGoalTitle.js";
import {
    clearGoal as clearStoredGoal,
    GOAL_CONTINUATION_ID_KEY,
    GOAL_FAILURE_COUNT_KEY,
    GOAL_LAST_INFERENCE_KEY,
    GOAL_LIFECYCLE_KEY,
    GOAL_OBSERVED_LIFECYCLE_ID_KEY,
    readGoal,
    readGoalAuthoritativeState,
    writeGoal,
    writeGoalLifecycle,
} from "./impl/goalState.js";
import { goalKV } from "./impl/goalKV.js";
import { normalizeGoalObjective } from "./impl/normalizeGoalObjective.js";
import { goalHostSchema, type GoalHost } from "./GoalHost.js";
import {
    FAILED_TURNS_BEFORE_BLOCKED,
    goalAgentIdSchema,
    goalMessageIdSchema,
    goalOperationIdSchema,
    goalStatusSchema,
    goalTimestampSchema,
    MAX_GOAL_OUTPUT_CHARACTERS,
    type GoalInterruptionReason,
    type GoalStatus,
    type SessionGoal,
} from "./SessionGoal.js";
import { createGoalTool } from "./tools/create_goal.js";
import { clearGoalTool } from "./tools/clear_goal.js";
import { getGoalTool } from "./tools/get_goal.js";
import { updateGoalTool } from "./tools/update_goal.js";

export { FAILED_TURNS_BEFORE_BLOCKED } from "./SessionGoal.js";

const goalInferenceSchema = Type.Object(
    {
        state: Type.Optional(
            Type.Union([
                Type.Literal("cancelled"),
                Type.Literal("normal"),
                Type.Literal("tool_call"),
                Type.Literal("length"),
                Type.Literal("error"),
            ]),
        ),
    },
    { additionalProperties: false },
);
const goalOutputCharactersSchema = Type.Integer({
    minimum: 256,
    maximum: MAX_GOAL_OUTPUT_CHARACTERS,
});
const goalIdFactorySchema = Type.Function(
    [goalContextSchema, goalAgentIdSchema],
    Type.Union([goalOperationIdSchema, Type.Promise(goalOperationIdSchema)]),
);
const goalEventIdFactorySchema = Type.Function(
    [goalContextSchema, goalAgentIdSchema],
    Type.Union([goalOperationIdSchema, Type.Promise(goalOperationIdSchema)]),
);
const goalClockSchema = Type.Function(
    [],
    Type.Union([goalTimestampSchema, Type.Promise(goalTimestampSchema)]),
);
const goalBooleanPromiseSchema = Type.Promise(Type.Boolean());
const goalFactoryPromiseSchema = Type.Promise(
    Type.Union([goalOperationIdSchema, goalTimestampSchema]),
);
const goalVoidPromiseSchema = Type.Promise(Type.Void());
const goalObserverErrorSchema = Type.String({ minLength: 1, maxLength: 500 });

export const goalModuleOptionsSchema = Type.Object(
    {
        host: Type.Optional(goalHostSchema),
        listener: Type.Optional(goalModuleListenerSchema),
        idFactory: Type.Optional(goalIdFactorySchema),
        eventIdFactory: Type.Optional(goalEventIdFactorySchema),
        clock: Type.Optional(goalClockSchema),
        maxOutputCharacters: Type.Optional(goalOutputCharactersSchema),
        onPostCommitError: Type.Optional(
            Type.Function(
                [goalContextSchema, goalEventSchema, goalObserverErrorSchema],
                goalVoidOrPromiseVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export type GoalModuleOptions = Static<typeof goalModuleOptionsSchema>;

interface GoalActivation {
    readonly goal: SessionGoal;
    readonly lifecycleId: string;
}

/**
 * Shared persistent goal state plus the hooks that keep an active goal moving.
 *
 * Goal owns only current domain state. Durable tool settlement belongs to Agent Base and is
 * committed with each transactional tool; Goal keeps no replay ledger.
 */
export class GoalModule implements AgentModule {
    readonly name = "goal";
    readonly migrations = [
        [
            "001-goal-state",
            async (ctx: Context): Promise<void> => {
                await agentDatabaseRun(
                    ctx.db,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_goal_state (
                        agent_id TEXT NOT NULL,
                        state_key TEXT NOT NULL,
                        value_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, state_key)
                    )`,
                );
            },
        ],
    ] as const;

    readonly #host: GoalHost | undefined;
    readonly #listener: GoalModuleListener | undefined;
    readonly #idFactory: NonNullable<GoalModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<GoalModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<GoalModuleOptions["clock"]>;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: NonNullable<GoalModuleOptions["onPostCommitError"]> | undefined;
    #agents: AgentSystemRef | undefined;

    constructor(options: GoalModuleOptions) {
        const normalized = normalizeGoalModuleOptions(options);
        assertGoalModuleOptions(normalized);
        this.#host = normalized.host;
        this.#listener = normalized.listener;
        this.#idFactory = normalized.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = normalized.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = normalized.clock ?? (() => Date.now());
        this.#maxOutputCharacters = normalized.maxOutputCharacters ?? 12_000;
        this.#onPostCommitError = normalized.onPostCommitError;
    }

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): Promise<void> => {
        this.#agents = agents;
        return Promise.resolve();
    };

    readonly agentArchivedTransact = async (
        ctx: Context,
        _scope: AgentModuleSystemScope,
        agent: AgentModuleAgentLifecycle,
    ): Promise<void> => {
        await this.#pauseActiveGoal(ctx, agent.id, "session_archived");
    };

    async goal(ctx: Context, agentId: string): Promise<SessionGoal | undefined> {
        this.#assertAgentId(agentId);
        return await readGoal(ctx, goalKV(agentId), agentId);
    }

    async setGoal(ctx: Context, agentId: string, objective: string): Promise<SessionGoal>;
    async setGoal(
        ctx: Context,
        agentId: string,
        objective: string,
        lifecycleId: string,
    ): Promise<GoalActivation>;
    async setGoal(
        ctx: Context,
        agentId: string,
        objective: string,
        lifecycleId?: string,
    ): Promise<SessionGoal | GoalActivation> {
        const activation = await ctx.inTx(
            async (txCtx) => await this.#setGoal(txCtx, agentId, objective, lifecycleId),
        );
        return lifecycleId === undefined ? activation.goal : activation;
    }

    async changeGoalStatus(
        ctx: Context,
        agentId: string,
        status: GoalStatus,
    ): Promise<SessionGoal> {
        return await ctx.inTx(
            async (txCtx) => await this.#changeGoalStatus(txCtx, agentId, status),
        );
    }

    async clearGoal(ctx: Context, agentId: string): Promise<boolean> {
        return await ctx.inTx(async (txCtx) => await this.#clearGoal(txCtx, agentId));
    }

    readonly tools = (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
        createGoalTool(
            this,
            scope.agent.id,
            this.#maxOutputCharacters,
            async (toolCtx, goal, lifecycleId) => {
                if (agentRunningInside(toolCtx) !== scope.agent.id) return;
                await scope.runKV.write(toolCtx, GOAL_OBSERVED_LIFECYCLE_ID_KEY, lifecycleId);
            },
        ),
        getGoalTool(this, scope.agent.id, this.#maxOutputCharacters),
        updateGoalTool(this, scope.agent.id, this.#maxOutputCharacters),
        clearGoalTool(this, scope.agent.id),
    ];

    readonly afterInferenceTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        inference: AgentBaseInference,
    ): Promise<void> => {
        const value = inference.state === undefined ? {} : { state: inference.state };
        if (!Value.Check(goalInferenceSchema, value)) {
            throw new Error("Goal inference state is invalid.");
        }
        await scope.runKV.write(ctx, GOAL_LAST_INFERENCE_KEY, value);
    };

    readonly afterTurnTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        turn: AgentBaseTurn,
    ): Promise<void> => {
        const inference = await scope.runKV.read(ctx, GOAL_LAST_INFERENCE_KEY);
        if (!Value.Check(Type.Union([goalInferenceSchema, Type.Undefined()]), inference)) {
            throw new Error("The stored Goal inference state is invalid.");
        }
        const failed =
            turn.aborted ||
            inference === undefined ||
            inference.state === undefined ||
            inference.state === "cancelled" ||
            inference.state === "error";
        if (!failed) return;
        await this.#pauseActiveGoal(
            ctx,
            scope.agent.id,
            turn.aborted ? "session_interrupted" : "session_failed",
        );
    };

    readonly beforeAgentLoopTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<void> => {
        const state = await readGoalAuthoritativeState(ctx, goalKV(scope.agent.id), scope.agent.id);
        await scope.runKV.delete(ctx, GOAL_CONTINUATION_ID_KEY);
        if (state.goal?.status !== "active") {
            await scope.runKV.delete(ctx, GOAL_OBSERVED_LIFECYCLE_ID_KEY);
        } else {
            const lifecycle = state.lifecycle;
            if (lifecycle === undefined) {
                throw new Error("An active Goal requires its exact lifecycle sidecar.");
            }
            await scope.runKV.write(ctx, GOAL_OBSERVED_LIFECYCLE_ID_KEY, lifecycle.id);
        }
    };

    readonly afterAgentLoop = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<readonly AgentModuleAction[] | undefined> => {
        const continuation = await ctx.inTx(async (txCtx) => {
            const kv = goalKV(scope.agent.id);
            const observed = await scope.runKV.read(txCtx, GOAL_OBSERVED_LIFECYCLE_ID_KEY);
            if (observed === undefined) return undefined;
            if (!Value.Check(goalOperationIdSchema, observed)) {
                throw new Error("The observed Goal lifecycle ID is invalid.");
            }
            const state = await readGoalAuthoritativeState(txCtx, kv, scope.agent.id);
            const current = state.goal;
            if (current?.status !== "active" || state.lifecycle?.id !== observed) {
                return undefined;
            }
            const inference = await scope.runKV.read(txCtx, GOAL_LAST_INFERENCE_KEY);
            if (!Value.Check(Type.Union([goalInferenceSchema, Type.Undefined()]), inference)) {
                throw new Error("The stored Goal inference state is invalid.");
            }
            const failed =
                inference === undefined ||
                inference.state === undefined ||
                inference.state === "error";
            if (failed) {
                const failures = (state.failureCount ?? 0) + 1;
                if (failures < FAILED_TURNS_BEFORE_BLOCKED) {
                    await kv.write(txCtx, GOAL_FAILURE_COUNT_KEY, failures);
                    return undefined;
                }
                const blocked: SessionGoal = {
                    ...current,
                    status: "blocked",
                    updatedAt: await this.#timestamp(txCtx),
                };
                await writeGoal(txCtx, kv, blocked);
                await this.#deactivate(txCtx, kv);
                await this.#publishEvent(
                    txCtx,
                    await this.#event(txCtx, {
                        type: "goal_status_changed",
                        agentId: scope.agent.id,
                        goal: blocked,
                    }),
                );
                return undefined;
            }
            await kv.delete(txCtx, GOAL_FAILURE_COUNT_KEY);
            const id = await this.#continuationActionId(txCtx, scope);
            return { id, goal: structuredClone(current) };
        });
        if (continuation === undefined) return undefined;
        return [
            {
                type: "send",
                id: continuation.id,
                message: {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: createGoalContinuationPrompt(continuation.goal),
                        },
                    ],
                },
                // A goal continuation is the agent driving itself, delivered in the user-role input
                // shape only because that is the shape a provider accepts. It carries no human
                // authority, so it is stamped agent-originated: without this an agent that set its
                // own goal objective would manufacture its own trusted permission evidence. The
                // sender stamp names the agent for attribution only and grants nothing.
                metadata: {
                    ...AGENT_MESSAGE_ORIGIN_METADATA,
                    ...senderAgentIdMetadata(scope.agent.id),
                },
            },
        ];
    };

    async #setGoal(
        ctx: Context,
        agentId: string,
        objective: string,
        requestedLifecycleId: string | undefined,
    ): Promise<GoalActivation> {
        this.#assertAgentId(agentId);
        await this.#assertPrimaryAgent(ctx, agentId);
        const normalized = normalizeGoalObjective(objective);
        if (
            requestedLifecycleId !== undefined &&
            !Value.Check(goalOperationIdSchema, requestedLifecycleId)
        ) {
            throw new Error("Goal lifecycle ID is invalid.");
        }
        const kv = goalKV(agentId);
        const state = await readGoalAuthoritativeState(ctx, kv, agentId);
        const existing = state.goal;
        if (existing !== undefined && existing.status !== "complete") {
            if (existing.status === "active" && existing.objective === normalized) {
                const lifecycle = state.lifecycle;
                if (lifecycle === undefined) {
                    throw new Error("An active Goal requires its exact lifecycle sidecar.");
                }
                return {
                    goal: structuredClone(existing),
                    lifecycleId: lifecycle.id,
                };
            }
            throw new Error(
                "This agent already has an unfinished goal. Complete or clear it before starting another.",
            );
        }
        const external = agentRunningInside(ctx) !== agentId;
        this.#assertCanActivateExternally(external);
        const lifecycleId =
            requestedLifecycleId ??
            (await this.#factoryValue<string>(
                this.#idFactory(ctx, agentId),
                goalOperationIdSchema,
                "Goal lifecycle ID",
            ));
        const at = await this.#timestamp(ctx);
        const goal: SessionGoal = {
            createdAt: at,
            objective: normalized,
            status: "active",
            updatedAt: at,
        };
        await writeGoal(ctx, kv, goal);
        await this.#setSessionTitle(ctx, agentId, normalized);
        await this.#activate(ctx, kv, lifecycleId, goal, external);
        await this.#publishEvent(ctx, await this.#event(ctx, { type: "goal_set", agentId, goal }));
        await this.#wakeExternalActivation(ctx, agentId, lifecycleId, goal, external);
        return { goal: structuredClone(goal), lifecycleId };
    }

    async #changeGoalStatus(
        ctx: Context,
        agentId: string,
        status: GoalStatus,
    ): Promise<SessionGoal> {
        this.#assertAgentId(agentId);
        await this.#assertPrimaryAgent(ctx, agentId);
        this.#assertStatus(status);
        const kv = goalKV(agentId);
        const state = await readGoalAuthoritativeState(ctx, kv, agentId);
        const existing = state.goal;
        if (existing === undefined) throw new Error("This agent does not have a goal.");
        if (existing.status === "complete" && status === "active") {
            throw new Error("A completed goal cannot be resumed. Start a new goal instead.");
        }
        if (existing.status === status) {
            return structuredClone(existing);
        }
        const external = agentRunningInside(ctx) !== agentId;
        if (status === "active") this.#assertCanActivateExternally(external);
        const goal: SessionGoal = {
            ...existing,
            status,
            updatedAt: await this.#timestamp(ctx),
        };
        await writeGoal(ctx, kv, goal);
        let lifecycleId: string | undefined;
        if (status === "active") {
            lifecycleId = await this.#factoryValue<string>(
                this.#idFactory(ctx, agentId),
                goalOperationIdSchema,
                "Goal lifecycle ID",
            );
            await this.#activate(ctx, kv, lifecycleId, goal, external);
        } else {
            await this.#deactivate(ctx, kv);
        }
        await this.#publishEvent(
            ctx,
            await this.#event(ctx, {
                type: "goal_status_changed",
                agentId,
                goal,
            }),
        );
        if (lifecycleId !== undefined) {
            await this.#wakeExternalActivation(ctx, agentId, lifecycleId, goal, external);
        } else if (status === "paused" || status === "blocked") {
            this.#scheduleHostInterruption(
                ctx,
                agentId,
                status === "paused" ? "goal_paused" : "goal_blocked",
            );
        }
        return structuredClone(goal);
    }

    async #clearGoal(ctx: Context, agentId: string): Promise<boolean> {
        this.#assertAgentId(agentId);
        await this.#assertPrimaryAgent(ctx, agentId);
        const kv = goalKV(agentId);
        const state = await readGoalAuthoritativeState(ctx, kv, agentId);
        const cleared = state.goal !== undefined;
        if (cleared) {
            await clearStoredGoal(ctx, kv);
            await this.#deactivate(ctx, kv);
            await this.#publishEvent(
                ctx,
                await this.#event(ctx, { type: "goal_cleared", agentId }),
            );
            this.#scheduleHostInterruption(ctx, agentId, "goal_cleared");
        }
        return cleared;
    }

    async #pauseActiveGoal(
        ctx: Context,
        agentId: string,
        reason: Extract<
            GoalInterruptionReason,
            "session_failed" | "session_interrupted" | "session_archived"
        >,
    ): Promise<boolean> {
        this.#assertAgentId(agentId);
        const kv = goalKV(agentId);
        const state = await readGoalAuthoritativeState(ctx, kv, agentId);
        const current = state.goal;
        if (current?.status !== "active") return false;
        const paused: SessionGoal = {
            ...current,
            status: "paused",
            updatedAt: await this.#timestamp(ctx),
        };
        await writeGoal(ctx, kv, paused);
        await this.#deactivate(ctx, kv);
        await this.#publishEvent(
            ctx,
            await this.#event(ctx, {
                type: "goal_status_changed",
                agentId,
                goal: paused,
            }),
        );
        this.#scheduleHostInterruption(ctx, agentId, reason);
        return true;
    }

    async #assertPrimaryAgent(ctx: Context, agentId: string): Promise<void> {
        const check = this.#host?.isPrimaryAgent;
        if (check === undefined) return;
        const result = check.call(this.#host, ctx, agentId);
        const primary = Value.Check(goalBooleanPromiseSchema, result) ? await result : result;
        if (!Value.Check(Type.Boolean(), primary)) {
            throw new Error("Goal primary-agent policy returned an invalid value.");
        }
        if (!primary) {
            throw new Error("Goals can only be managed from the primary session.");
        }
    }

    async #setSessionTitle(ctx: Context, agentId: string, objective: string): Promise<void> {
        const setTitle = this.#host?.setSessionTitle;
        if (setTitle === undefined) return;
        await this.#awaitVoidResult(
            setTitle.call(this.#host, ctx, agentId, createGoalTitle(objective)),
            "Goal session title callback",
        );
    }

    #scheduleHostInterruption(ctx: Context, agentId: string, reason: GoalInterruptionReason): void {
        const interrupt = this.#host?.interruptGoalWork;
        if (interrupt === undefined) return;
        afterCommit(ctx, async (postCommitCtx) => {
            try {
                await this.#awaitVoidResult(
                    interrupt.call(this.#host, postCommitCtx, agentId, reason),
                    "Goal host interruption callback",
                );
            } catch {
                // Host cleanup is advisory after the durable Goal transition has committed.
            }
        });
    }

    async #activate(
        ctx: Context,
        kv: ReturnType<typeof goalKV>,
        lifecycleId: string,
        goal: SessionGoal,
        external: boolean,
    ): Promise<void> {
        await writeGoalLifecycle(ctx, kv, {
            activation: external ? "external" : "agent",
            id: lifecycleId,
            goal: structuredClone(goal),
        });
        await kv.delete(ctx, GOAL_FAILURE_COUNT_KEY);
    }

    async #deactivate(ctx: Context, kv: ReturnType<typeof goalKV>): Promise<void> {
        await kv.delete(ctx, GOAL_LIFECYCLE_KEY);
        await kv.delete(ctx, GOAL_FAILURE_COUNT_KEY);
    }

    #assertCanActivateExternally(external: boolean): void {
        if (external && this.#agents === undefined) {
            throw new Error(
                "Activating a Goal from outside the owning agent requires the agent system. " +
                    "Add the Goal module to an AgentSystem so its beforeStart hook can capture it.",
            );
        }
    }

    async #wakeExternalActivation(
        ctx: Context,
        agentId: string,
        lifecycleId: string,
        goal: SessionGoal,
        external: boolean,
    ): Promise<void> {
        if (!external) return;
        const agents = this.#agents;
        if (agents === undefined) {
            throw new Error("Goal agent system disappeared during activation.");
        }
        await agents.send(
            ctx,
            agentId,
            {
                role: "user",
                content: [{ type: "text", text: createGoalContinuationPrompt(goal) }],
            },
            { id: continuationMessageId(agentId, lifecycleId, goal) },
        );
    }

    async #publishEvent(ctx: Context, event: GoalEvent): Promise<void> {
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await this.#awaitVoidResult(
                transactional.call(this.#listener, ctx, event),
                "Goal transactional listener",
            );
        }
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #event(
        ctx: Context,
        payload:
            | { readonly type: "goal_set"; readonly agentId: string; readonly goal: SessionGoal }
            | {
                  readonly type: "goal_status_changed";
                  readonly agentId: string;
                  readonly goal: SessionGoal;
              }
            | { readonly type: "goal_cleared"; readonly agentId: string },
    ): Promise<GoalEvent> {
        const eventId = await this.#factoryValue<string>(
            this.#eventIdFactory(ctx, payload.agentId),
            goalOperationIdSchema,
            "Goal event ID",
        );
        const at = await this.#timestamp(ctx);
        const event = { ...payload, eventId, at } as unknown;
        if (!Value.Check(goalEventSchema, event)) throw new Error("Goal event is invalid.");
        return deepFreeze(structuredClone(event) as GoalEvent);
    }

    async #timestamp(_ctx: Context): Promise<number> {
        return await this.#factoryValue<number>(this.#clock(), goalTimestampSchema, "Goal clock");
    }

    async #factoryValue<T>(
        value: unknown,
        schema: Parameters<typeof Value.Check>[0],
        label: string,
    ): Promise<T> {
        const resolved = Value.Check(goalFactoryPromiseSchema, value) ? await value : value;
        if (!Value.Check(schema, resolved)) throw new Error(`${label} returned an invalid value.`);
        return resolved as T;
    }

    async #continuationActionId(ctx: Context, scope: AgentModuleScope): Promise<string> {
        const existing = await scope.runKV.read(ctx, GOAL_CONTINUATION_ID_KEY);
        if (existing !== undefined) {
            if (!Value.Check(goalMessageIdSchema, existing)) {
                throw new Error("The stored Goal continuation ID is invalid.");
            }
            return existing as string;
        }
        const source = await this.#factoryValue<string>(
            this.#idFactory(ctx, scope.agent.id),
            goalOperationIdSchema,
            "Goal continuation ID",
        );
        const id = hashMessageId(["goal-continuation", scope.agent.id, source]);
        await scope.runKV.write(ctx, GOAL_CONTINUATION_ID_KEY, id);
        return id;
    }

    async #awaitVoidResult(value: unknown, label: string): Promise<void> {
        const resolved = Value.Check(goalVoidPromiseSchema, value) ? await value : value;
        if (!Value.Check(Type.Void(), resolved)) {
            throw new Error(`${label} must return void or a Promise<void>.`);
        }
    }

    async #notifyPostCommit(ctx: Context, event: GoalEvent): Promise<void> {
        try {
            const callback = this.#listener?.onEvent;
            if (callback !== undefined) {
                await this.#awaitVoidResult(
                    callback.call(this.#listener, ctx, event),
                    "Goal post-commit listener",
                );
            }
        } catch (error: unknown) {
            try {
                const reporter = this.#onPostCommitError;
                if (reporter !== undefined) {
                    await this.#awaitVoidResult(
                        reporter(ctx, event, normalizeObserverError(error)),
                        "Goal post-commit error reporter",
                    );
                }
            } catch {
                // Reporting is advisory after durable state has committed.
            }
        }
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(goalAgentIdSchema, agentId)) throw new Error("Goal agent ID is invalid.");
    }

    #assertStatus(status: string): asserts status is GoalStatus {
        if (!Value.Check(goalStatusSchema, status)) throw new Error("Goal status is invalid.");
    }
}

export function assertGoalModuleOptions(value: unknown): asserts value is GoalModuleOptions {
    const candidate = normalizeGoalModuleOptions(value);
    if (!Value.Check(goalModuleOptionsSchema, candidate)) {
        throw new Error("Goal module options are invalid.");
    }
}

function normalizeGoalModuleOptions(value: unknown): unknown {
    try {
        if (!isObjectRecord(value)) return value;
        const option = { ...value };
        option.listener = normalizeClassBackedCallbacks(option.listener, [
            "onEventTransactional",
            "onEvent",
        ]);
        option.host = normalizeClassBackedCallbacks(option.host, [
            "isPrimaryAgent",
            "setSessionTitle",
            "interruptGoalWork",
        ]);
        return option;
    } catch {
        return undefined;
    }
}

function normalizeClassBackedCallbacks(value: unknown, names: readonly string[]): unknown {
    if (!isClassBacked(value)) return value;
    const normalized: Record<string, unknown> = { ...value };
    for (const name of names) {
        const callback = Reflect.get(value, name);
        if (callback !== undefined) {
            normalized[name] = typeof callback === "function" ? callback.bind(value) : callback;
        }
    }
    return normalized;
}

function continuationMessageId(agentId: string, lifecycleId: string, goal: SessionGoal): string {
    return hashMessageId([
        "goal-external-wake",
        agentId,
        lifecycleId,
        goal.objective,
        goal.createdAt,
    ]);
}

function hashMessageId(parts: readonly (string | number)[]): string {
    const id = `g${createHash("sha256")
        .update(JSON.stringify(parts), "utf8")
        .digest("hex")
        .slice(0, 31)}`;
    if (!Value.Check(goalMessageIdSchema, id)) {
        throw new Error("Goal message identity is invalid.");
    }
    return id;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isClassBacked(value: unknown): value is object {
    if (!isObjectRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}

function normalizeObserverError(error: unknown): string {
    try {
        if (
            error instanceof Error &&
            typeof error.message === "string" &&
            error.message.length > 0
        ) {
            return error.message.slice(0, 500);
        }
        const converted = String(error);
        if (converted.length > 0) return converted.slice(0, 500);
    } catch {
        // Use the bounded fallback below.
    }
    return "Unknown Goal observer error.";
}
