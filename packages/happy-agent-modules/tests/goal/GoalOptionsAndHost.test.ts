import { withAgentContext } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";
import type { Context } from "@steve.kite/stdlib";

import { GoalModule } from "../../sources/goal/GoalModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { recordingAgents } from "./recordingAgents.js";

function ownerContext(context: Context, agentId: string): Context {
    return withAgentContext(context, {
        id: agentId,
        provider: "scripted",
        permissionMode: "auto",
    });
}

describe("Goal options and host seams", () => {
    it("rejects invalid option bounds and unknown nested keys", () => {
        expect(() => new GoalModule({ maxOutputCharacters: 255 })).toThrow(
            "Goal module options are invalid",
        );
        expect(() => new GoalModule({ maxOutputCharacters: 100_001 })).toThrow(
            "Goal module options are invalid",
        );
        expect(
            () =>
                new GoalModule({
                    host: { isPrimaryAgent: () => true, unexpected: true } as never,
                }),
        ).toThrow("Goal module options are invalid");
        expect(
            () =>
                new GoalModule({
                    listener: { onEvent: () => undefined, unexpected: true } as never,
                }),
        ).toThrow("Goal module options are invalid");
        expect(() => new GoalModule(null as never)).toThrow("Goal module options are invalid");
    });

    it("accepts async factories and rejects invalid async results", async () => {
        const module = new GoalModule({
            idFactory: async () => "lifecycle-a",
            eventIdFactory: async () => "event-a",
            clock: async () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-async-factories-test");
        await database.ready;
        const agents = recordingAgents();
        await module.beforeStart(database.context, agents.ref);
        try {
            await module.setGoal(database.context, "agent-a", "ship it");
            await expect(module.goal(database.context, "agent-a")).resolves.toMatchObject({
                status: "active",
            });
        } finally {
            database.close();
        }

        const invalid = new GoalModule({
            idFactory: async () => "" as never,
        });
        const invalidDatabase = moduleDatabase(
            invalid.migrations,
            "goal-invalid-async-factory-test",
        );
        await invalidDatabase.ready;
        const invalidAgents = recordingAgents();
        await invalid.beforeStart(invalidDatabase.context, invalidAgents.ref);
        try {
            await expect(
                invalid.setGoal(invalidDatabase.context, "agent-a", "ship it"),
            ).rejects.toThrow("lifecycle ID returned an invalid value");
            await expect(invalid.goal(invalidDatabase.context, "agent-a")).resolves.toBeUndefined();
        } finally {
            invalidDatabase.close();
        }
    });

    it("enforces the primary-agent policy and validates its result", async () => {
        const allowed = new GoalModule({
            host: {
                isPrimaryAgent: async (_ctx, agentId) => agentId === "primary",
            },
            idFactory: () => "lifecycle-a",
            clock: () => 100,
        });
        const allowedDatabase = moduleDatabase(allowed.migrations, "goal-async-primary-test");
        await allowedDatabase.ready;
        const allowedAgents = recordingAgents();
        await allowed.beforeStart(allowedDatabase.context, allowedAgents.ref);
        try {
            await expect(
                allowed.setGoal(allowedDatabase.context, "primary", "ship it"),
            ).resolves.toMatchObject({ status: "active" });
            await expect(
                allowed.setGoal(allowedDatabase.context, "secondary", "ship it"),
            ).rejects.toThrow("primary session");
        } finally {
            allowedDatabase.close();
        }

        const invalid = new GoalModule({
            host: {
                isPrimaryAgent: async () => "not-a-boolean" as never,
            },
            idFactory: () => "lifecycle-a",
            clock: () => 100,
        });
        const invalidDatabase = moduleDatabase(invalid.migrations, "goal-invalid-primary-test");
        await invalidDatabase.ready;
        const invalidAgents = recordingAgents();
        await invalid.beforeStart(invalidDatabase.context, invalidAgents.ref);
        try {
            await expect(
                invalid.setGoal(invalidDatabase.context, "agent-a", "ship it"),
            ).rejects.toThrow("primary-agent policy returned an invalid value");
        } finally {
            invalidDatabase.close();
        }
    });

    it("contains host interruption failures after durable state commits", async () => {
        const interruptions: string[] = [];
        const module = new GoalModule({
            host: {
                interruptGoalWork: async (_ctx, _agentId, reason) => {
                    interruptions.push(reason);
                    throw new Error("host cleanup failed");
                },
            },
            idFactory: () => "lifecycle-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-host-interruption-failure-test");
        await database.ready;
        const agents = recordingAgents();
        await module.beforeStart(database.context, agents.ref);
        try {
            await module.setGoal(database.context, "agent-a", "ship it");
            await module.changeGoalStatus(database.context, "agent-a", "blocked");

            await expect(module.goal(database.context, "agent-a")).resolves.toMatchObject({
                status: "blocked",
            });
            expect(interruptions).toEqual(["goal_blocked"]);
        } finally {
            database.close();
        }
    });

    it("rejects invalid host void results and rolls back the mutation", async () => {
        const module = new GoalModule({
            host: {
                setSessionTitle: () => "not-void" as never,
            },
            idFactory: () => "lifecycle-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-invalid-title-result-test");
        await database.ready;
        try {
            await expect(
                module.setGoal(ownerContext(database.context, "agent-a"), "agent-a", "ship it"),
            ).rejects.toThrow("must return void");
            await expect(module.goal(database.context, "agent-a")).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("reports hostile post-commit errors with a bounded fallback", async () => {
        const reports: string[] = [];
        const hostile = new Proxy(
            {},
            {
                get: () => {
                    throw new Error("cannot inspect");
                },
            },
        );
        const module = new GoalModule({
            listener: {
                onEvent: () => {
                    throw hostile;
                },
            },
            onPostCommitError: (_ctx, _event, message) => {
                reports.push(message);
            },
            idFactory: () => "lifecycle-a",
            eventIdFactory: () => "event-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-hostile-observer-error-test");
        await database.ready;
        try {
            await module.setGoal(ownerContext(database.context, "agent-a"), "agent-a", "ship it");
            expect(reports).toEqual(["Unknown Goal observer error."]);
        } finally {
            database.close();
        }
    });
});
