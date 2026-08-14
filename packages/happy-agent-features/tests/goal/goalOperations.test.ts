import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { GoalFeature, type GoalEvent } from "../../sources/index.js";
import { agentWorld } from "../support/agentWorld.js";

const ctx = createRootContext().named("happy-agent-features-goal-operations");

/** A feature whose events are recorded as they arrive, transactional ones marked as such. */
function recordingFeature(): { goals: GoalFeature; events: string[] } {
    const events: string[] = [];
    const describe_ = (event: GoalEvent): string =>
        event.type === "goal_cleared"
            ? `${event.type} ${event.agentId}`
            : `${event.type} ${event.agentId} ${event.goal.status}`;
    const goals = new GoalFeature({
        storage: agentWorld().storage,
        listener: {
            onEventTransactional: (_ctx, event) => {
                events.push(`transactional: ${describe_(event)}`);
            },
            onEvent: (_ctx, event) => {
                events.push(`committed: ${describe_(event)}`);
            },
        },
    });
    return { goals, events };
}

describe("goal operations", () => {
    it("sets, reads, and clears the goal of an agent that has never run", async () => {
        const goals = new GoalFeature({ storage: agentWorld().storage });

        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
        const goal = await goals.setGoal(ctx, "agent-1", "  ship the thing  ");

        expect(goal).toEqual({
            createdAt: expect.any(Number),
            objective: "ship the thing",
            status: "active",
            updatedAt: goal.createdAt,
        });
        expect(await goals.goal(ctx, "agent-1")).toEqual(goal);
        expect(await goals.clearGoal(ctx, "agent-1")).toBe(true);
        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
        expect(await goals.clearGoal(ctx, "agent-1")).toBe(false);
    });

    it("keeps each agent's goal to itself", async () => {
        const goals = new GoalFeature({ storage: agentWorld().storage });

        await goals.setGoal(ctx, "agent-1", "ship the thing");

        expect(await goals.goal(ctx, "agent-2")).toBeUndefined();
    });

    it("refuses an objective that says nothing", async () => {
        const goals = new GoalFeature({ storage: agentWorld().storage });

        await expect(goals.setGoal(ctx, "agent-1", "   ")).rejects.toThrow("must not be empty");
        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
    });

    it("refuses to replace a goal that is not finished", async () => {
        const goals = new GoalFeature({ storage: agentWorld().storage });
        const first = await goals.setGoal(ctx, "agent-1", "ship the thing");

        await expect(goals.setGoal(ctx, "agent-1", "ship something else")).rejects.toThrow(
            "already has an unfinished goal",
        );
        expect(await goals.goal(ctx, "agent-1")).toEqual(first);
    });

    it("answers a repeated call with the goal it already started", async () => {
        const { goals, events } = recordingFeature();
        const first = await goals.setGoal(ctx, "agent-1", "ship the thing");

        const again = await goals.setGoal(ctx, "agent-1", "ship the thing");

        expect(again).toEqual(first);
        expect(events).toEqual([
            "transactional: goal_set agent-1 active",
            "committed: goal_set agent-1 active",
        ]);
    });

    it("starts a new goal once the previous one is complete", async () => {
        const goals = new GoalFeature({ storage: agentWorld().storage });
        await goals.setGoal(ctx, "agent-1", "ship the thing");
        await goals.changeGoalStatus(ctx, "agent-1", "complete");

        const next = await goals.setGoal(ctx, "agent-1", "ship the next thing");

        expect(next.status).toBe("active");
        expect(next.objective).toBe("ship the next thing");
    });

    it("moves the goal between statuses and says nothing about a status it already has", async () => {
        const { goals, events } = recordingFeature();
        const created = await goals.setGoal(ctx, "agent-1", "ship the thing");
        events.length = 0;

        const paused = await goals.changeGoalStatus(ctx, "agent-1", "paused");
        const unchanged = await goals.changeGoalStatus(ctx, "agent-1", "paused");

        expect(paused).toEqual({ ...created, status: "paused", updatedAt: paused.updatedAt });
        expect(unchanged).toEqual(paused);
        expect(events).toEqual([
            "transactional: goal_status_changed agent-1 paused",
            "committed: goal_status_changed agent-1 paused",
        ]);
    });

    it("says so when there is no goal to change", async () => {
        const goals = new GoalFeature({ storage: agentWorld().storage });

        await expect(goals.changeGoalStatus(ctx, "agent-1", "complete")).rejects.toThrow(
            "does not have a goal",
        );
    });

    it("tells the transactional listener before the change is readable, and the other after", async () => {
        const world = agentWorld();
        const seen: string[] = [];
        const goals: GoalFeature = new GoalFeature({
            storage: world.storage,
            listener: {
                onEventTransactional: async (txCtx) => {
                    // The change has not committed yet, so a reader outside the transaction
                    // still sees the store as it was.
                    seen.push(`transactional sees ${String(await goals.goal(ctx, "agent-1"))}`);
                    void txCtx;
                },
                onEvent: () => {
                    seen.push("committed");
                },
            },
        });

        await goals.setGoal(ctx, "agent-1", "ship the thing");

        expect(seen).toEqual(["transactional sees undefined", "committed"]);
        expect((await goals.goal(ctx, "agent-1"))?.objective).toBe("ship the thing");
    });

    it("rolls the change back when the transactional listener fails", async () => {
        const goals = new GoalFeature({
            storage: agentWorld().storage,
            listener: {
                onEventTransactional: () => {
                    throw new Error("the listener refused");
                },
            },
        });

        await expect(goals.setGoal(ctx, "agent-1", "ship the thing")).rejects.toThrow(
            "the listener refused",
        );
        expect(await goals.goal(ctx, "agent-1")).toBeUndefined();
    });

    it("serializes concurrent changes to one agent's goal", async () => {
        const goals = new GoalFeature({ storage: agentWorld().storage });

        const [first, second] = await Promise.allSettled([
            goals.setGoal(ctx, "agent-1", "ship the thing"),
            goals.setGoal(ctx, "agent-1", "ship something else"),
        ]);

        // One of them decided first; the other found the goal it left behind rather than
        // deciding from the same empty store.
        expect([first?.status, second?.status].sort()).toEqual(["fulfilled", "rejected"]);
        expect((await goals.goal(ctx, "agent-1"))?.status).toBe("active");
    });
});
