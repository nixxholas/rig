import {
    agentId as agentRunningInside,
    type AgentBaseInference,
    type AgentFeature,
    type AgentFeatureAction,
    type AgentFeatureScope,
    type AgentKV,
    type AgentStorage,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import type { GoalEvent, GoalFeatureListener } from "./GoalEvent.js";
import { createGoalContinuationPrompt } from "./impl/createGoalContinuationPrompt.js";
import { goalKV } from "./impl/goalKV.js";
import { clearGoal, readGoal, writeGoal } from "./impl/goalStore.js";
import { normalizeGoalObjective } from "./impl/normalizeGoalObjective.js";
import type { GoalStatus, SessionGoal } from "./SessionGoal.js";
import { createGoalTool } from "./tools/create_goal.js";
import { getGoalTool } from "./tools/get_goal.js";
import { updateGoalTool } from "./tools/update_goal.js";

/** What a goal feature is built with. */
export interface GoalFeatureOptions {
    /** The collection's storage, which is how the feature reaches any agent's goal. */
    readonly storage: AgentStorage;
    /** Told about every goal change, inside and after the transaction that commits it. */
    readonly listener?: GoalFeatureListener;
}

/**
 * How many turns in a row may end badly before the goal stops driving the agent. A goal that
 * keeps asking for another turn while every turn fails would run forever, so after this many the
 * goal is marked blocked and waits for a person.
 */
const FAILED_TURNS_BEFORE_BLOCKED = 3;

/** What one change decided: the goal it left behind, and the event worth announcing it as. */
interface GoalChange {
    readonly goal: SessionGoal | undefined;
    readonly event: GoalEvent | undefined;
}

/**
 * Long-running work, as three tools, one hook, and an API of its own.
 *
 * A goal is an objective the agent keeps pursuing past the end of a reply. The model starts one
 * with `create_goal`, reads it with `get_goal`, and ends it with `update_goal` by declaring it
 * complete or blocked. The hook is what makes it long-running: when the agent would settle back
 * to idle with the goal still active, the feature sends it a message asking it to carry on, and
 * the loop starts another turn instead of stopping.
 *
 * The same operations are public methods. A caller outside the agent system — an API, a command
 * — sets, reads, pauses, resumes, and clears the goal of any agent in the collection by ID,
 * whether or not that agent is running. The tools are those methods with a model-facing
 * description around them, so neither caller can see or do anything the other cannot.
 *
 * One instance serves every agent in a collection, and its tools and methods may be called at
 * the same time from anywhere, so every change to one agent's goal takes that agent's own lock.
 * Each agent's goal lives in that agent's own feature store, so it follows the conversation and
 * survives a restart.
 */
export class GoalFeature implements AgentFeature {
    readonly name = "goal";

    /** How the feature reaches the store of any agent in the collection. */
    readonly #storage: AgentStorage;
    /** Whoever is told about goal changes, if anyone. */
    readonly #listener: GoalFeatureListener | undefined;
    /**
     * One lock per agent, so a tool call and an outside call changing the same goal take their
     * turn instead of both deciding from the same reading. Agents are independent, so a goal
     * being set on one never holds up another.
     */
    readonly #locks = new Map<string, AsyncLock>();
    /** The collection this feature belongs to, kept from the moment it starts. */
    #agents: AgentSystemRef | undefined;
    /** How the last inference of the turn in progress ended, per agent. */
    readonly #lastInference = new Map<string, AgentBaseInference>();
    /** How many turns in a row have ended badly, per agent. */
    readonly #failedTurns = new Map<string, number>();

    constructor(options: GoalFeatureOptions) {
        this.#storage = options.storage;
        this.#listener = options.listener;
    }

    /**
     * Keep the collection the feature is part of. It is what lets a goal set from outside reach
     * the agent it belongs to: storing the objective tells nobody, so the agent is sent the
     * message that starts it working.
     */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): Promise<void> => {
        this.#agents = agents;
        return Promise.resolve();
    };

    /** The agent's goal, or nothing when it has never had one. */
    async goal(ctx: Context, agentId: string): Promise<SessionGoal | undefined> {
        return await readGoal(ctx, goalKV(this.#storage, agentId));
    }

    /**
     * Start the agent on an objective. A goal that is not finished cannot be replaced, but
     * setting the same objective again answers with the goal already running: that is one call
     * arriving twice, and it must neither fail nor start a second goal.
     */
    async setGoal(ctx: Context, agentId: string, objective: string): Promise<SessionGoal> {
        const wanted = normalizeGoalObjective(objective);
        const { goal } = await this.#change(ctx, agentId, async (kv, txCtx, existing) => {
            if (existing !== undefined && existing.status !== "complete") {
                if (existing.objective === wanted && existing.status === "active") {
                    return { goal: existing, event: undefined };
                }
                throw new Error(
                    "This agent already has an unfinished goal. Complete or clear it before starting another.",
                );
            }
            const at = Date.now();
            const goal: SessionGoal = {
                createdAt: at,
                objective: wanted,
                status: "active",
                updatedAt: at,
            };
            await writeGoal(txCtx, kv, goal);
            return { goal, event: { type: "goal_set", agentId, goal } };
        });
        if (goal === undefined) throw new Error("The goal was not stored.");
        await this.#wake(ctx, agentId, goal);
        return goal;
    }

    /**
     * Move the goal to another status: complete or blocked when the model has decided, paused or
     * active when the person who set it has. Setting the status it already has changes nothing
     * and announces nothing.
     */
    async changeGoalStatus(
        ctx: Context,
        agentId: string,
        status: GoalStatus,
    ): Promise<SessionGoal> {
        const { goal } = await this.#change(ctx, agentId, async (kv, txCtx, existing) => {
            if (existing === undefined) throw new Error("This agent does not have a goal.");
            if (existing.status === status) return { goal: existing, event: undefined };
            const changed: SessionGoal = { ...existing, status, updatedAt: Date.now() };
            await writeGoal(txCtx, kv, changed);
            return {
                goal: changed,
                event: { type: "goal_status_changed", agentId, goal: changed },
            };
        });
        if (goal === undefined) throw new Error("The goal was not stored.");
        await this.#wake(ctx, agentId, goal);
        return goal;
    }

    /** Forget the goal entirely. Answers whether there was one to forget. */
    async clearGoal(ctx: Context, agentId: string): Promise<boolean> {
        const { event } = await this.#change(ctx, agentId, async (kv, txCtx, existing) => {
            if (existing === undefined) return { goal: undefined, event: undefined };
            await clearGoal(txCtx, kv);
            return { goal: undefined, event: { type: "goal_cleared", agentId } };
        });
        return event !== undefined;
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        createGoalTool(this, scope.agent.id),
        getGoalTool(this, scope.agent.id),
        updateGoalTool(this, scope.agent.id),
    ];

    readonly afterInference = (
        _ctx: Context,
        scope: AgentFeatureScope,
        inference: AgentBaseInference,
    ): void => {
        this.#lastInference.set(scope.agent.id, inference);
    };

    readonly afterAgentLoop = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<readonly AgentFeatureAction[] | undefined> => {
        const agentId = scope.agent.id;
        const goal = await this.goal(ctx, agentId);
        if (goal?.status !== "active") {
            this.#failedTurns.delete(agentId);
            return undefined;
        }
        // A turn that ended badly would most likely end the same way again, and a goal that asks
        // for another one regardless would keep an agent failing forever. So a bad turn stops the
        // goal from driving the agent, and enough of them in a row leave the goal to a person.
        if (this.#turnFailed(agentId)) {
            const failures = (this.#failedTurns.get(agentId) ?? 0) + 1;
            this.#failedTurns.set(agentId, failures);
            if (failures >= FAILED_TURNS_BEFORE_BLOCKED) {
                this.#failedTurns.delete(agentId);
                await this.changeGoalStatus(ctx, agentId, "blocked");
            }
            return undefined;
        }
        this.#failedTurns.delete(agentId);
        return [
            {
                type: "send",
                message: {
                    role: "user",
                    content: [{ type: "text", text: createGoalContinuationPrompt(goal) }],
                },
            },
        ];
    };

    /** Whether the last thing this agent's turn did was fail. */
    #turnFailed(agentId: string): boolean {
        const inference = this.#lastInference.get(agentId);
        // A stream that ended without saying how it went is a failure like any other.
        return (
            inference === undefined || inference.state === undefined || inference.state === "error"
        );
    }

    /**
     * Set an agent working on the goal it has just been given. A goal stored from outside tells
     * the agent nothing by itself, so it is sent the message that would have carried it into the
     * next turn anyway. Nothing is sent when the change came from inside the agent's own turn:
     * its own loop asks for the next turn when this one ends.
     */
    async #wake(ctx: Context, agentId: string, goal: SessionGoal): Promise<void> {
        if (goal.status !== "active") return;
        if (agentRunningInside(ctx) === agentId) return;
        await this.#agents?.send(ctx, agentId, {
            role: "user",
            content: [{ type: "text", text: createGoalContinuationPrompt(goal) }],
        });
    }

    /**
     * Decide one change to an agent's goal, commit it, and announce it.
     *
     * The decision runs alone — under that agent's lock, and inside one transaction — so what it
     * read is still what it replaces when it writes. A transactional listener is part of that
     * transaction and can roll it back with a failure; the ordinary listener is told afterwards,
     * with the change already durable and the lock already released, so whatever it does with
     * the news cannot hold the next change up.
     */
    async #change(
        ctx: Context,
        agentId: string,
        decide: (
            kv: AgentKV,
            txCtx: Context,
            existing: SessionGoal | undefined,
        ) => Promise<GoalChange>,
    ): Promise<GoalChange> {
        const store = goalKV(this.#storage, agentId);
        const change = await this.#lockFor(agentId).runInLock(ctx, (lockCtx) =>
            store.transaction(lockCtx, async (kv, txCtx) => {
                const decided = await decide(kv, txCtx, await readGoal(txCtx, kv));
                if (decided.event !== undefined) {
                    await this.#listener?.onEventTransactional?.(txCtx, decided.event);
                }
                return decided;
            }),
        );
        if (change.event !== undefined) this.#listener?.onEvent?.(ctx, change.event);
        return change;
    }

    /** The lock every change to this agent's goal takes, created the first time it is needed. */
    #lockFor(agentId: string): AsyncLock {
        const existing = this.#locks.get(agentId);
        if (existing !== undefined) return existing;
        const lock = asyncLock({ reentry: "block" });
        this.#locks.set(agentId, lock);
        return lock;
    }
}
