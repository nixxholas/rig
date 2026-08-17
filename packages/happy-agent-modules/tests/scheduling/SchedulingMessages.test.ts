import { describe, expect, it } from "vitest";

import type { SchedulingEvent } from "../../sources/scheduling/SchedulingEvent.js";
import { schedulingHarness, settle, TestAgents } from "./support/schedulingHarness.js";

const sender = "agenta";
const recipient = "agentb";

describe("Scheduled messages", () => {
    it("delivers a message itself when its time comes and records that it arrived", async () => {
        const harness = await schedulingHarness("message-delivered");
        try {
            const scheduled = await harness.module.schedule(harness.database.context, sender, {
                id: "messageone",
                targetAgentId: recipient,
                message: "Check the release",
                in: { minutes: 5 },
            });
            expect(scheduled).toMatchObject({ status: "pending", dueAt: 301_000 });
            expect(harness.agents.delivered).toEqual([]);

            await harness.clock.advance(5 * 60_000);

            expect(harness.agents.delivered).toEqual([
                {
                    agentId: recipient,
                    id: "messageone",
                    text: "A message agent agenta scheduled for now:\n\nCheck the release",
                    metadata: {
                        scheduling: {
                            scheduleId: "messageone",
                            senderAgentId: sender,
                            targetAgentId: recipient,
                        },
                        senderAgentId: sender,
                    },
                },
            ]);
            const settled = await harness.module.getSchedule(
                harness.database.context,
                sender,
                "messageone",
            );
            expect(settled).toMatchObject({ status: "delivered", deliveredAt: 301_000 });
        } finally {
            harness.close();
        }
    });

    it("addresses a message to the sender itself", async () => {
        const harness = await schedulingHarness("message-to-self");
        try {
            await harness.module.schedule(harness.database.context, sender, {
                id: "messageself",
                message: "Remember the deploy",
                in: { seconds: 30 },
            });
            await harness.clock.advance(30_000);

            expect(harness.agents.delivered[0]).toMatchObject({
                agentId: sender,
                text: "A message you scheduled for now:\n\nRemember the deploy",
            });
        } finally {
            harness.close();
        }
    });

    it("keeps an undelivered message with its sender, with the reason it failed", async () => {
        const harness = await schedulingHarness("message-undelivered");
        try {
            harness.agents.failNextDeliveries("That agent has been closed.");
            await harness.module.schedule(harness.database.context, sender, {
                id: "messagefail",
                targetAgentId: recipient,
                message: "Check the release",
                in: { seconds: 10 },
            });
            await harness.clock.advance(10_000);

            expect(
                await harness.module.getSchedule(harness.database.context, sender, "messagefail"),
            ).toMatchObject({
                status: "undelivered",
                failure: "That agent has been closed.",
                senderAgentId: sender,
            });
        } finally {
            harness.close();
        }
    });

    it("cancels a message before it leaves, and never delivers it", async () => {
        const harness = await schedulingHarness("message-cancelled");
        try {
            await harness.module.schedule(harness.database.context, sender, {
                id: "messagestop",
                message: "Never mind",
                in: { minutes: 1 },
            });
            const cancelled = await harness.module.cancelSchedule(
                harness.database.context,
                sender,
                { scheduleId: "messagestop" },
            );
            expect(cancelled.status).toBe("cancelled");
            expect(harness.clock.armed).toBe(0);

            await harness.clock.advance(60_000);
            expect(harness.agents.delivered).toEqual([]);
            expect(harness.module.formatCancellationForModel(cancelled)).toBe(
                "Message messagestop is now cancelled before delivery.",
            );
        } finally {
            harness.close();
        }
    });

    it("leaves a delivered message delivered when a cancellation arrives late", async () => {
        const harness = await schedulingHarness("message-cancel-late");
        try {
            await harness.module.schedule(harness.database.context, sender, {
                id: "messagelate",
                message: "Already gone",
                in: { seconds: 1 },
            });
            await harness.clock.advance(1_000);

            expect(
                await harness.module.cancelSchedule(harness.database.context, sender, {
                    scheduleId: "messagelate",
                }),
            ).toMatchObject({ status: "delivered" });
            expect(harness.agents.delivered).toHaveLength(1);
        } finally {
            harness.close();
        }
    });

    it("arms everything left pending when the process starts again", async () => {
        const first = await schedulingHarness("message-recovered");
        try {
            await first.module.schedule(first.database.context, sender, {
                id: "messagelives",
                targetAgentId: recipient,
                message: "Survives a restart",
                in: { minutes: 10 },
            });
            first.module.stop();
            expect(first.clock.armed).toBe(0);

            const second = await schedulingHarness("message-recovered", {
                agents: first.agents,
                clock: first.clock,
                database: first.database,
            });
            expect(second.clock.armed).toBe(1);

            await second.clock.advance(10 * 60_000);
            expect(second.agents.delivered).toHaveLength(1);
            expect(
                await second.module.getSchedule(second.database.context, sender, "messagelives"),
            ).toMatchObject({ status: "delivered" });
        } finally {
            first.close();
        }
    });

    it("delivers a message the recipient is waiting for, and ends that wait", async () => {
        const harness = await schedulingHarness("message-ends-wait");
        try {
            await harness.module.schedule(harness.database.context, sender, {
                id: "messagewake",
                targetAgentId: recipient,
                message: "Wake up",
                in: { seconds: 30 },
            });
            const waiting = harness.module.wait(harness.database.context, recipient, {
                id: "waitforit",
                duration: { hours: 2 },
            });
            await settle();

            await harness.clock.advance(30_000);

            expect(await waiting).toMatchObject({ outcome: "interrupted", elapsedMs: 30_000 });
        } finally {
            harness.close();
        }
    });

    it("treats the same durable call as one message, not two", async () => {
        const harness = await schedulingHarness("message-replay");
        try {
            const first = await harness.module.schedule(harness.database.context, sender, {
                id: "messageonce",
                message: "Only once",
                in: { seconds: 20 },
            });
            const replayed = await harness.module.schedule(harness.database.context, sender, {
                id: "messageonce",
                message: "Only once",
                in: { seconds: 20 },
            });

            expect(replayed).toEqual(first);
            await harness.clock.advance(20_000);
            expect(harness.agents.delivered).toHaveLength(1);
        } finally {
            harness.close();
        }
    });

    it("shows an agent only its own messages, and lets only the sender cancel one", async () => {
        const harness = await schedulingHarness("message-ownership");
        try {
            await harness.module.schedule(harness.database.context, sender, {
                id: "messagemine",
                targetAgentId: recipient,
                message: "From A",
                in: { minutes: 1 },
            });
            await harness.module.schedule(harness.database.context, recipient, {
                id: "messageyours",
                message: "From B",
                in: { minutes: 1 },
            });

            const page = await harness.module.listSchedulePage(harness.database.context, sender);
            expect(page.schedules.map((schedule) => schedule.id)).toEqual(["messagemine"]);
            // The recipient may read a message addressed to it, but not withdraw it.
            expect(
                await harness.module.getSchedule(
                    harness.database.context,
                    recipient,
                    "messagemine",
                ),
            ).toMatchObject({ id: "messagemine" });
            await expect(
                harness.module.cancelSchedule(harness.database.context, recipient, {
                    scheduleId: "messagemine",
                }),
            ).rejects.toThrow("does not exist");
        } finally {
            harness.close();
        }
    });

    it("gives transactional and post-commit listeners the same frozen events", async () => {
        const transactional: SchedulingEvent[] = [];
        const postCommit: SchedulingEvent[] = [];
        const harness = await schedulingHarness("message-events", {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
                onEvent: (_ctx, event) => {
                    postCommit.push(event);
                },
            },
        });
        try {
            await harness.module.schedule(harness.database.context, sender, {
                id: "messageseen",
                message: "Observed",
                in: { seconds: 5 },
            });
            await harness.clock.advance(5_000);

            expect(transactional.map((event) => event.type)).toEqual([
                "message_scheduled",
                "scheduled_message_delivery_outcome",
            ]);
            expect(postCommit).toEqual(transactional);
            expect(Object.isFrozen(transactional[0])).toBe(true);
        } finally {
            harness.close();
        }
    });

    it("trims a page to the output budget without stepping over a message", async () => {
        const harness = await schedulingHarness("message-page", { maxOutputCharacters: 256 });
        try {
            for (let index = 0; index < 6; index += 1) {
                await harness.module.schedule(harness.database.context, sender, {
                    id: `messagepage${index}`,
                    targetAgentId: recipient,
                    message: `Message ${index}`,
                    in: { minutes: index + 1 },
                });
            }

            const page = await harness.module.listSchedulePage(harness.database.context, sender);
            const text = harness.module.formatSchedulePageForModel(page);
            const shown = text.split("\n").filter((line) => line.startsWith("messagepage"));

            expect(text.length).toBeLessThanOrEqual(256);
            expect(shown.length).toBeGreaterThan(0);
            expect(text).toContain(`More messages start at cursor ${shown.length}.`);
        } finally {
            harness.close();
        }
    });

    it("refuses a message further away than the horizon allows", async () => {
        const harness = await schedulingHarness("message-horizon");
        try {
            await expect(
                harness.module.schedule(harness.database.context, sender, {
                    id: "messagefar",
                    message: "Too far",
                    in: { days: 3 },
                }),
            ).rejects.toThrow("longer than the 1 day limit");
        } finally {
            harness.close();
        }
    });

    it("has no scheduler, authorization, or delivery-reporting surface left", async () => {
        const exports = await import("../../sources/scheduling/index.js");
        expect("schedulingSchedulerSchema" in exports).toBe(false);
        expect("schedulingAuthorizationSchema" in exports).toBe(false);
        expect("schedulingDeliveryOutcomeInputSchema" in exports).toBe(false);
        expect("scheduler" in exports.schedulingModuleOptionsSchema.properties).toBe(false);
    });
});
