import { sql } from "drizzle-orm";
import {
    agentDatabaseRows,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentStorageTransaction,
} from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { GoalModule } from "../../sources/goal/GoalModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { recordingAgents } from "./recordingAgents.js";

function goalTestModule(name: string) {
    let transactions = 0;
    let inTransaction = false;
    const database = moduleDatabase(
        new GoalModule({
            transaction: async () => {
                throw new Error("bootstrap transaction is never called");
            },
        }).migrations,
        name,
    );
    const transaction: AgentStorageTransaction = async (ctx, work) => {
        transactions += 1;
        inTransaction = true;
        try {
            return await work(
                ctx,
                database.database as AgentDatabaseFacade<AgentDatabase>,
            );
        } finally {
            inTransaction = false;
        }
    };
    const module = new GoalModule({
        transaction,
        idFactory: () => "public-lifecycle",
        eventIdFactory: () => "event-id",
        clock: () => 123,
    });
    return {
        database,
        module,
        transactions: () => transactions,
        inTransaction: () => inTransaction,
    };
}

describe("GoalModule", () => {
    it("keeps only current goal state and performs each public operation in one transaction", async () => {
        const test = goalTestModule("goal-state-test");
        await test.database.ready;
        const agents = recordingAgents();
        await test.module.beforeStart(test.database.context, agents.ref);
        try {
            const goal = await test.module.setGoal(
                test.database.context,
                "agent-a",
                "  ship it  ",
            );
            expect(goal).toEqual({
                createdAt: 123,
                objective: "ship it",
                status: "active",
                updatedAt: 123,
            });
            expect(test.transactions()).toBe(1);

            await test.module.changeGoalStatus(
                test.database.context,
                "agent-a",
                "complete",
            );
            expect(test.transactions()).toBe(2);
            await expect(test.module.clearGoal(test.database.context, "agent-a")).resolves.toBe(
                true,
            );
            expect(test.transactions()).toBe(3);

            const rows = await agentDatabaseRows<{ state_key: string }>(
                test.database.database,
                sql`SELECT state_key FROM happy_agent_goal_state ORDER BY state_key`,
            );
            expect(rows).toEqual([]);
        } finally {
            test.database.close();
        }
    });

    it("uses call.id for the lifecycle and commits the durable result inside the mutation transaction", async () => {
        const test = goalTestModule("goal-tool-commit-test");
        await test.database.ready;
        const agents = recordingAgents();
        await test.module.beforeStart(test.database.context, agents.ref);
        let committed = 0;
        try {
            const result = await test.module.createGoalFromTool(
                test.database.context,
                "agent-tool",
                "ship it",
                {
                    id: "call-cuid2",
                    commit: async (_ctx, value) => {
                        expect(test.inTransaction()).toBe(true);
                        committed += 1;
                        return value;
                    },
                },
                async () => undefined,
            );

            expect(result.goal.status).toBe("active");
            expect(committed).toBe(1);
            expect(test.transactions()).toBe(1);
            const rows = await agentDatabaseRows<{ value_json: string }>(
                test.database.database,
                sql`SELECT value_json
                    FROM happy_agent_goal_state
                    WHERE agent_id = ${"agent-tool"} AND state_key = ${"lifecycle"}`,
            );
            expect(JSON.parse(rows[0]?.value_json ?? "null")).toMatchObject({
                id: "call-cuid2",
            });
        } finally {
            test.database.close();
        }
    });
});