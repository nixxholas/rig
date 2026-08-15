import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { GoalModule } from "../../sources/goal/GoalModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
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
        await test.module.beforeStart(test.database.context, agents.ref);
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

            const tools = test.module.tools(test.database.context, {
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
});
