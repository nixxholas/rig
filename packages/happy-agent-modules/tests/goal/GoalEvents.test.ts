import { withAgentContext } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";
import type { Context } from "@steve.kite/stdlib";

import { GoalModule } from "../../sources/goal/GoalModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

function ownerContext(context: Context, agentId: string): Context {
    return withAgentContext(context, {
        id: agentId,
        provider: "scripted",
        permissionMode: "auto",
    });
}

describe("Goal events and transaction boundaries", () => {
    it("delivers one deeply frozen event to both listeners with stable identity", async () => {
        let transactionalEvent: object | undefined;
        let postCommitEvent: object | undefined;
        const module = new GoalModule({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactionalEvent = event;
                    expect(Object.isFrozen(event)).toBe(true);
                    if (event.type === "goal_set") {
                        expect(Object.isFrozen(event.goal)).toBe(true);
                    }
                },
                onEvent: (_ctx, event) => {
                    postCommitEvent = event;
                    expect(Object.isFrozen(event)).toBe(true);
                    if (event.type === "goal_set") {
                        expect(Object.isFrozen(event.goal)).toBe(true);
                    }
                },
            },
            idFactory: () => "lifecycle-a",
            eventIdFactory: () => "event-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-event-identity-test");
        await database.ready;
        try {
            await module.setGoal(ownerContext(database.context, "agent-a"), "agent-a", "ship it");

            expect(postCommitEvent).toBe(transactionalEvent);
            expect(transactionalEvent).toMatchObject({
                type: "goal_set",
                eventId: "event-a",
                at: 100,
                agentId: "agent-a",
            });
        } finally {
            database.close();
        }
    });

    it("does not publish post-commit events or durable state after an outer rollback", async () => {
        const transactionalEvents: string[] = [];
        const postCommitEvents: string[] = [];
        const module = new GoalModule({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactionalEvents.push(event.type);
                },
                onEvent: (_ctx, event) => {
                    postCommitEvents.push(event.type);
                },
            },
            idFactory: () => "lifecycle-a",
            eventIdFactory: () => "event-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-event-rollback-test");
        await database.ready;
        try {
            const ctx = ownerContext(database.context, "agent-a");
            await expect(
                ctx.inTx(async (txCtx) => {
                    await module.setGoal(txCtx, "agent-a", "ship it");
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");

            expect(transactionalEvents).toEqual(["goal_set"]);
            expect(postCommitEvents).toEqual([]);
            await expect(module.goal(database.context, "agent-a")).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains post-commit listener failures and reports bounded error text", async () => {
        const reports: { readonly eventId: string; readonly message: string }[] = [];
        const module = new GoalModule({
            listener: {
                onEvent: () => {
                    throw new Error("post-commit observer failed");
                },
            },
            onPostCommitError: (_ctx, event, message) => {
                reports.push({ eventId: event.eventId, message });
            },
            idFactory: () => "lifecycle-a",
            eventIdFactory: () => "event-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-event-observer-error-test");
        await database.ready;
        try {
            await module.setGoal(ownerContext(database.context, "agent-a"), "agent-a", "ship it");

            await expect(module.goal(database.context, "agent-a")).resolves.toMatchObject({
                status: "active",
            });
            expect(reports).toEqual([
                { eventId: "event-a", message: "post-commit observer failed" },
            ]);
        } finally {
            database.close();
        }
    });

    it("uses class-backed listener methods with their owning this value", async () => {
        class Listener {
            readonly #seen: string[] = [];

            onEventTransactional(_ctx: Context, event: { readonly type: string }): void {
                this.#seen.push(event.type);
            }

            get seen(): readonly string[] {
                return this.#seen;
            }
        }
        const listener = new Listener();
        const module = new GoalModule({
            listener,
            idFactory: () => "lifecycle-a",
            eventIdFactory: () => "event-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-event-class-listener-test");
        await database.ready;
        try {
            await module.setGoal(ownerContext(database.context, "agent-a"), "agent-a", "ship it");
            expect(listener.seen).toEqual(["goal_set"]);
        } finally {
            database.close();
        }
    });

    it("rejects invalid factory outputs before writing durable state", async () => {
        const invalidId = new GoalModule({ idFactory: () => "" });
        const invalidClock = new GoalModule({ clock: () => -1 });
        const invalidEvent = new GoalModule({ eventIdFactory: () => "" });
        const cases = [
            ["goal-event-invalid-lifecycle-test", invalidId, "lifecycle ID"],
            ["goal-event-invalid-clock-test", invalidClock, "clock"],
            ["goal-event-invalid-id-test", invalidEvent, "event ID"],
        ] as const;

        for (const [name, candidate, message] of cases) {
            const database = moduleDatabase(candidate.migrations, name);
            await database.ready;
            try {
                await expect(
                    candidate.setGoal(
                        ownerContext(database.context, "agent-a"),
                        "agent-a",
                        "ship it",
                    ),
                ).rejects.toThrow(message);
                await expect(candidate.goal(database.context, "agent-a")).resolves.toBeUndefined();
            } finally {
                database.close();
            }
        }
    });

    it("does not leave a host title behind when the enclosing mutation rolls back", async () => {
        const titles: string[] = [];
        const module = new GoalModule({
            host: {
                setSessionTitle: (_ctx, _agentId, title) => {
                    titles.push(title);
                },
            },
            listener: {
                onEventTransactional: () => {
                    throw new Error("reject goal");
                },
            },
            idFactory: () => "lifecycle-a",
            clock: () => 100,
        });
        const database = moduleDatabase(module.migrations, "goal-title-rollback-test");
        await database.ready;
        try {
            await expect(
                module.setGoal(ownerContext(database.context, "agent-a"), "agent-a", "ship it"),
            ).rejects.toThrow("reject goal");
            expect(titles).toEqual([]);
        } finally {
            database.close();
        }
    });
});
