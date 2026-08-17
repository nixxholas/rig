import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { GoalModule } from "../../sources/goal/GoalModule.js";
import { GOAL_LAST_INFERENCE_KEY } from "../../sources/goal/impl/goalState.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { recordingAgents } from "./recordingAgents.js";

function goalTestModule(name: string) {
    let rejectStatusChange = false;
    const module = new GoalModule({
        listener: {
            onEventTransactional: (_ctx, event) => {
                if (rejectStatusChange && event.type === "goal_status_changed") {
                    throw new Error("reject status change");
                }
            },
        },
        idFactory: () => "public-lifecycle",
        eventIdFactory: () => "event-id",
        clock: () => 123,
    });
    const database = moduleDatabase(module.migrations, name);
    return {
        database,
        module,
        rejectStatusChanges: () => {
            rejectStatusChange = true;
        },
    };
}

describe("GoalModule", () => {
    it("uses ctx.db and rolls back a rejected multi-step public mutation", async () => {
        const test = goalTestModule("goal-state-test");
        await test.database.ready;
        const agents = recordingAgents();
        await test.module.beforeStart(test.database.context, agents.ref);
        try {
            const goal = await test.module.setGoal(test.database.context, "agent-a", "  ship it  ");
            expect(goal).toEqual({
                createdAt: 123,
                objective: "ship it",
                status: "active",
                updatedAt: 123,
            });
            test.rejectStatusChanges();
            await expect(
                test.module.changeGoalStatus(test.database.context, "agent-a", "complete"),
            ).rejects.toThrow("reject status change");
            await expect(test.module.goal(test.database.context, "agent-a")).resolves.toMatchObject(
                { status: "active" },
            );

            await expect(test.module.clearGoal(test.database.context, "agent-a")).resolves.toBe(
                true,
            );

            const rows = await agentDatabaseRows<{ state_key: string }>(
                test.database.database,
                sql`SELECT state_key FROM happy_agent_goal_state ORDER BY state_key`,
            );
            expect(rows).toEqual([]);
        } finally {
            test.database.close();
        }
    });

    it("uses call.id for lifecycle identity and leaves durable completion to transactional tools", async () => {
        const test = goalTestModule("goal-transactional-tool-test");
        await test.database.ready;
        const agents = recordingAgents();
        const hooks = await resolveModuleHooks(test.database.context, test.module, agents.ref);
        try {
            const activation = await test.module.setGoal(
                test.database.context,
                "agent-tool",
                "ship it",
                "call-cuid2",
            );

            expect(activation.goal.status).toBe("active");
            expect(activation.lifecycleId).toBe("call-cuid2");
            const rows = await agentDatabaseRows<{ value_json: string }>(
                test.database.database,
                sql`SELECT value_json
                    FROM happy_agent_goal_state
                    WHERE agent_id = ${"agent-tool"} AND state_key = ${"lifecycle"}`,
            );
            expect(JSON.parse(rows[0]?.value_json ?? "null")).toMatchObject({
                id: "call-cuid2",
            });

            const tools = await hooks.tools!(test.database.context, {
                agent: { id: "agent-tool" },
            } as never);
            expect(tools.map((tool) => [tool.name, tool.durable, tool.transactional])).toEqual([
                ["create_goal", true, true],
                ["get_goal", true, true],
                ["update_goal", true, true],
                ["clear_goal", true, true],
            ]);
        } finally {
            test.database.close();
        }
    });

    it("does not resume a completed goal", async () => {
        const test = goalTestModule("goal-completed-resume-test");
        await test.database.ready;
        const agents = recordingAgents();
        await test.module.beforeStart(test.database.context, agents.ref);
        try {
            await test.module.setGoal(test.database.context, "agent-complete", "ship it");
            await test.module.changeGoalStatus(test.database.context, "agent-complete", "complete");

            await expect(
                test.module.changeGoalStatus(test.database.context, "agent-complete", "active"),
            ).rejects.toThrow("A completed goal cannot be resumed. Start a new goal instead.");
            await expect(
                test.module.goal(test.database.context, "agent-complete"),
            ).resolves.toMatchObject({ status: "complete" });
        } finally {
            test.database.close();
        }
    });

    it("uses the optional host seam for primary identity, titles, and post-commit interruption", async () => {
        const titles: { readonly agentId: string; readonly title: string }[] = [];
        const interruptions: { readonly agentId: string; readonly reason: string }[] = [];
        const module = new GoalModule({
            host: {
                isPrimaryAgent: async (_ctx, agentId) => agentId === "primary-agent",
                setSessionTitle: (_ctx, agentId, title) => {
                    titles.push({ agentId, title });
                },
                interruptGoalWork: (_ctx, agentId, reason) => {
                    interruptions.push({ agentId, reason });
                },
            },
            idFactory: () => "host-lifecycle",
            eventIdFactory: () => "host-event",
            clock: () => 456,
        });
        const database = moduleDatabase(module.migrations, "goal-host-seam-test");
        await database.ready;
        const agents = recordingAgents();
        await module.beforeStart(database.context, agents.ref);
        try {
            await expect(
                module.setGoal(database.context, "subagent", "not allowed"),
            ).rejects.toThrow("Goals can only be managed from the primary session.");

            await module.setGoal(database.context, "primary-agent", "  first line\nsecond line  ");
            expect(titles).toEqual([{ agentId: "primary-agent", title: "first line second line" }]);

            await module.changeGoalStatus(database.context, "primary-agent", "blocked");
            expect(interruptions).toEqual([{ agentId: "primary-agent", reason: "goal_blocked" }]);

            await module.clearGoal(database.context, "primary-agent");
            expect(interruptions).toEqual([
                { agentId: "primary-agent", reason: "goal_blocked" },
                { agentId: "primary-agent", reason: "goal_cleared" },
            ]);
        } finally {
            database.close();
        }
    });

    it("pauses an active goal after a failed turn and after archival", async () => {
        const interruptions: string[] = [];
        const module = new GoalModule({
            host: {
                interruptGoalWork: (_ctx, _agentId, reason) => {
                    interruptions.push(reason);
                },
            },
            idFactory: () => "pause-lifecycle",
            eventIdFactory: () => "pause-event",
            clock: () => 789,
        });
        const database = moduleDatabase(module.migrations, "goal-auto-pause-test");
        await database.ready;
        const agents = recordingAgents();
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runValues = new Map<string, unknown>();
        const runKV = {
            read: async (_ctx: unknown, key: string) => runValues.get(key),
            write: async (_ctx: unknown, key: string, value: unknown) => {
                runValues.set(key, value);
            },
            delete: async (_ctx: unknown, key: string) => {
                runValues.delete(key);
            },
        };
        try {
            await module.setGoal(database.context, "agent-failed", "ship it");
            runValues.set(GOAL_LAST_INFERENCE_KEY, { state: "error" });
            await hooks.afterTurnTransact!(
                database.context,
                {
                    agent: { id: "agent-failed" },
                    runKV,
                } as never,
                {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: undefined,
                    aborted: false,
                },
            );
            await expect(module.goal(database.context, "agent-failed")).resolves.toMatchObject({
                status: "paused",
            });
            expect(interruptions).toEqual(["session_failed"]);

            await module.setGoal(database.context, "agent-archived", "archive me");
            await hooks.agentArchivedTransact!(database.context, { sharedKV: {} } as never, {
                id: "agent-archived",
                metadata: undefined,
            });
            await expect(module.goal(database.context, "agent-archived")).resolves.toMatchObject({
                status: "paused",
            });
            expect(interruptions).toEqual(["session_failed", "session_archived"]);
        } finally {
            database.close();
        }
    });
});
