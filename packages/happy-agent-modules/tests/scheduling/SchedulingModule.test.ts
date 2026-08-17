import type { AgentModuleHooks, AgentModuleScope } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import * as SchedulingExports from "../../sources/scheduling/index.js";
import { SchedulingModule } from "../../sources/scheduling/SchedulingModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import {
    InMemorySchedulingScheduler,
    InMemorySchedulingStore,
} from "./support/InMemoryScheduling.js";

const agentId = "agent-a";

interface Harness {
    readonly database: ReturnType<typeof moduleDatabase>;
    readonly module: SchedulingModule;
    readonly hooks: AgentModuleHooks;
    readonly scheduler: InMemorySchedulingScheduler;
    readonly setNow: (value: number) => void;
}

async function harness(
    name: string,
    listener?: ConstructorParameters<typeof SchedulingModule>[0]["listener"],
): Promise<Harness> {
    const scheduler = new InMemorySchedulingScheduler(new InMemorySchedulingStore());
    let now = 1_000;
    let eventId = 0;
    const module = new SchedulingModule({
        scheduler,
        clock: () => now,
        idFactory: () => "publicschedule1",
        eventIdFactory: () => `event${++eventId}`,
        scheduleMessagePolicy: () => true,
        authorization: () => true,
        ...(listener === undefined ? {} : { listener }),
    });
    const database = moduleDatabase(module.migrations, name);
    await database.ready;
    const hooks = await resolveModuleHooks(database.context, module);
    return {
        database,
        module,
        hooks,
        scheduler,
        setNow: (value) => {
            now = value;
        },
    };
}

describe("SchedulingModule", () => {
    it("exports no module-owned transaction or idempotency contracts", () => {
        expect("schedulingMutationReceiptSchema" in SchedulingExports).toBe(false);
        expect("schedulingMutationProofSchema" in SchedulingExports).toBe(false);
        expect("schedulingTransactionChangeSchema" in SchedulingExports).toBe(false);
        expect("transaction" in SchedulingExports.schedulingModuleOptionsSchema.properties).toBe(
            false,
        );
    });

    it("uses ctx.db for public schedule mutations", async () => {
        const created = await harness("scheduling-schedule");
        try {
            let scheduleUsedRootDatabase = false;
            const hostSchedule = created.scheduler.schedule.bind(created.scheduler);
            created.scheduler.schedule = async (ctx, actingAgentId, request) => {
                scheduleUsedRootDatabase = ctx.db === created.database.database;
                return await hostSchedule(ctx, actingAgentId, request);
            };
            const result = await created.module.schedule(created.database.context, agentId, {
                id: "schedule1",
                message: "Continue the release",
                in: { seconds: 1 },
            });

            expect(result).toMatchObject({
                id: "schedule1",
                senderAgentId: agentId,
                targetAgentId: agentId,
                status: "pending",
            });
            expect(created.scheduler.calls).toEqual(["schedule"]);
            expect(scheduleUsedRootDatabase).toBe(true);
        } finally {
            created.database.close();
        }
    });

    it("keeps host waits outside the start and settle transactions", async () => {
        const created = await harness("scheduling-wait-boundaries");
        try {
            let hostWaitUsedRootDatabase = false;
            let hostStartUsedRootDatabase = false;
            const hostStart = created.scheduler.startWait.bind(created.scheduler);
            created.scheduler.startWait = async (ctx, agent, request) => {
                hostStartUsedRootDatabase = ctx.db === created.database.database;
                return await hostStart(ctx, agent, request);
            };
            const hostWait = created.scheduler.wait.bind(created.scheduler);
            created.scheduler.wait = async (ctx, agent, waitId) => {
                hostWaitUsedRootDatabase = ctx.db === created.database.database;
                return await hostWait(ctx, agent, waitId);
            };
            const pending = created.module.wait(created.database.context, agentId, {
                id: "wait1",
                duration: { seconds: 1 },
            });
            await created.scheduler.waitStartedFor("wait1");

            created.setNow(2_000);
            created.scheduler.settle("wait1", {
                waitId: "wait1",
                agentId,
                outcome: "elapsed",
                kind: "wait",
                dueAt: 2_000,
                startedAt: 1_000,
                endedAt: 2_000,
                elapsedMs: 1_000,
            });

            await expect(pending).resolves.toMatchObject({
                waitId: "wait1",
                outcome: "elapsed",
            });
            expect(created.scheduler.calls).toEqual(["startWait", "wait"]);
            expect(hostWaitUsedRootDatabase).toBe(true);
            expect(hostStartUsedRootDatabase).toBe(true);
        } finally {
            created.database.close();
        }
    });

    it("marks one-transaction tools transactional but leaves long waits unwrapped", async () => {
        const created = await harness("scheduling-tool-surface");
        try {
            const scope = { agent: { id: agentId } } as AgentModuleScope;
            const tools = await created.hooks.tools!(created.database.context, scope);
            const byName = new Map(tools.map((tool) => [tool.name, tool]));

            expect(tools.every((tool) => tool.durable)).toBe(true);
            expect(byName.get("schedule_message")?.transactional).not.toBe(true);
            expect(byName.get("cancel_scheduled_message")?.transactional).not.toBe(true);
            expect(byName.get("list_scheduled_messages")?.transactional).toBe(true);
            expect(byName.get("wait")?.transactional).not.toBe(true);
            expect(byName.get("wait_until")?.transactional).not.toBe(true);
        } finally {
            created.database.close();
        }
    });

    it("reconciles a stable host schedule after catalog finalization rolls back", async () => {
        let reject = true;
        const created = await harness("scheduling-retry-contract", {
            onEventTransactional: async (_ctx, event) => {
                if (reject && event.type === "message_scheduled") {
                    throw new Error("reject catalog finalization");
                }
            },
        });
        const input = {
            id: "schedule1",
            message: "Continue the release",
            in: { seconds: 1 },
        } as const;
        try {
            await expect(
                created.module.schedule(created.database.context, agentId, input),
            ).rejects.toThrow("reject catalog finalization");
            reject = false;
            await expect(
                created.module.schedule(created.database.context, agentId, input),
            ).resolves.toMatchObject({ id: "schedule1", status: "pending" });
            expect(created.scheduler.calls).toEqual(["schedule", "schedule"]);
        } finally {
            created.database.close();
        }
    });

    it("lets the model schedule to the requested agent", async () => {
        const created = await harness("scheduling-target-tool");
        try {
            const scope = { agent: { id: agentId } } as AgentModuleScope;
            const tool = (await created.hooks.tools!(created.database.context, scope)).find(
                (candidate) => candidate.name === "schedule_message",
            );
            expect(tool).toBeDefined();
            expect(
                Value.Check(tool!.parameters, {
                    input: {
                        agent_id: "agent-b",
                        message: "Review the release",
                        in: { seconds: 1 },
                    },
                }),
            ).toBe(true);
            const result = await tool!.execute(
                created.database.context,
                {
                    input: {
                        agent_id: "agent-b",
                        message: "Review the release",
                        in: { seconds: 1 },
                    },
                },
                { id: "schedule1", providerCallId: "provider-schedule1", kv: {} } as never,
            );

            expect(result).toMatchObject({
                id: "schedule1",
                senderAgentId: agentId,
                targetAgentId: "agent-b",
                status: "pending",
            });
        } finally {
            created.database.close();
        }
    });

    it("allows a scheduled-message horizon longer than the wait horizon", async () => {
        const scheduler = new InMemorySchedulingScheduler(new InMemorySchedulingStore());
        const module = new SchedulingModule({
            scheduler,
            clock: () => 1_000,
            idFactory: () => "schedule1",
            eventIdFactory: () => "event1",
            scheduleMessagePolicy: () => true,
            maxScheduleHorizon: 7 * 24 * 60 * 60 * 1_000,
        });
        const database = moduleDatabase(module.migrations, "scheduling-long-horizon");
        await database.ready;
        try {
            const result = await module.schedule(database.context, agentId, {
                id: "schedule1",
                message: "Review this next week",
                in: { days: 2 },
            });

            expect(result.dueAt).toBe(2 * 24 * 60 * 60 * 1_000 + 1_000);
        } finally {
            database.close();
        }
    });

    it("accepts RFC dates and Unix timestamps and clamps past dates", async () => {
        const created = await harness("scheduling-date-forms");
        try {
            const rfc = await created.module.schedule(created.database.context, agentId, {
                id: "schedule1",
                message: "Review this soon",
                at: "Thu, 01 Jan 1970 00:00:02 GMT",
            });
            const unixSeconds = await created.module.schedule(created.database.context, agentId, {
                id: "schedule2",
                message: "Review this soon too",
                at: 2,
            });
            expect(rfc.dueAt).toBe(2_000);
            expect(unixSeconds.dueAt).toBe(2_000);

            let requestDueAt: number | undefined;
            const hostStart = created.scheduler.startWait.bind(created.scheduler);
            created.scheduler.startWait = async (ctx, waitingAgentId, request) => {
                requestDueAt = request.dueAt;
                return await hostStart(ctx, waitingAgentId, request);
            };
            const pending = created.module.waitUntil(created.database.context, agentId, {
                id: "wait1",
                at: "Thu, 01 Jan 1959 00:00:00 GMT",
            });
            await created.scheduler.waitStartedFor("wait1");
            expect(requestDueAt).toBe(1_000);
            created.scheduler.settle("wait1", {
                waitId: "wait1",
                agentId,
                outcome: "elapsed",
                kind: "wait_until",
                dueAt: 1_000,
                startedAt: 1_000,
                endedAt: 1_000,
                elapsedMs: 0,
            });
            await expect(pending).resolves.toMatchObject({
                waitId: "wait1",
                outcome: "elapsed",
                elapsedMs: 0,
            });
        } finally {
            created.database.close();
        }
    });

    it("accepts compound and human-readable wait durations", async () => {
        const created = await harness("scheduling-duration-forms");
        try {
            let requestDueAt: number | undefined;
            const hostStart = created.scheduler.startWait.bind(created.scheduler);
            created.scheduler.startWait = async (ctx, waitingAgentId, request) => {
                requestDueAt = request.dueAt;
                return await hostStart(ctx, waitingAgentId, request);
            };
            const pending = created.module.wait(created.database.context, agentId, {
                id: "wait1",
                seconds: 30,
                minutes: 1,
            });
            const scope = { agent: { id: agentId } } as AgentModuleScope;
            const waitTool = (await created.hooks.tools!(created.database.context, scope)).find(
                (candidate) => candidate.name === "wait",
            );
            expect(
                Value.Check(waitTool!.parameters, {
                    input: { seconds: 30, minutes: 1 },
                }),
            ).toBe(true);
            await created.scheduler.waitStartedFor("wait1");
            expect(requestDueAt).toBe(91_000);
            created.setNow(91_000);
            created.scheduler.settle("wait1", {
                waitId: "wait1",
                agentId,
                outcome: "elapsed",
                kind: "wait",
                dueAt: 91_000,
                startedAt: 1_000,
                endedAt: 91_000,
                elapsedMs: 90_000,
            });
            await expect(pending).resolves.toMatchObject({ elapsedMs: 90_000 });

            created.setNow(1_000);
            const scheduled = await created.module.schedule(created.database.context, agentId, {
                id: "schedule1",
                message: "Use the human form",
                in: "90 seconds",
            });
            expect(scheduled.dueAt).toBe(91_000);
        } finally {
            created.database.close();
        }
    });

    it("does not expose schedule_message when no role policy is supplied", async () => {
        const scheduler = new InMemorySchedulingScheduler(new InMemorySchedulingStore());
        const module = new SchedulingModule({ scheduler });
        const hooks = await resolveModuleHooks({} as never, module);
        const scope = { agent: { id: agentId } } as AgentModuleScope;
        const tools = await hooks.tools!({} as never, scope);

        expect(tools.map((tool) => tool.name)).not.toContain("schedule_message");
        await expect(
            module.schedule({} as never, agentId, {
                id: "schedule1",
                message: "This must remain unavailable",
                in: { seconds: 1 },
            }),
        ).rejects.toThrow("not allowed to schedule messages");
    });
});
