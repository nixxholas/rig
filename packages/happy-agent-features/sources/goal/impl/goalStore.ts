import { Value } from "@sinclair/typebox/value";
import type { AgentKV } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { sessionGoalSchema, type SessionGoal } from "../SessionGoal.js";

/** Where the goal lives inside the feature's own store. One agent has at most one goal. */
export const GOAL_KEY = "goal";

/**
 * The stored goal, or nothing when the agent has never had one. The goal belongs to the
 * conversation rather than to a run: it is read back after a restart, and an agent picks up an
 * objective it was pursuing when the process died.
 */
export async function readGoal(ctx: Context, kv: AgentKV): Promise<SessionGoal | undefined> {
    const stored = await kv.read(ctx, GOAL_KEY);
    if (stored === undefined) return undefined;
    if (!Value.Check(sessionGoalSchema, stored)) {
        throw new Error("The stored goal is not a goal this version can read.");
    }
    return stored;
}

/** Store the goal, replacing whatever was there. */
export async function writeGoal(ctx: Context, kv: AgentKV, goal: SessionGoal): Promise<void> {
    await kv.write(ctx, GOAL_KEY, goal);
}

/** Forget the goal entirely, so the agent stops being asked to continue it. */
export async function clearGoal(ctx: Context, kv: AgentKV): Promise<void> {
    await kv.delete(ctx, GOAL_KEY);
}
