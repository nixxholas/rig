import { describe, expect, it } from "vitest";

import * as SchedulingExports from "../../sources/scheduling/index.js";
import { SchedulingModule } from "../../sources/scheduling/SchedulingModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import {
    InMemorySchedulingScheduler,
    InMemorySchedulingStore,
} from "./support/InMemoryScheduling.js";

const agentId = "agent-a";

interface Harness {
    readonly database: ReturnType<typeof moduleDatabase>;
    readonly module: SchedulingModule;
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
        ...(listener === undefined ? {} : { listener }),
    });
    const database = moduleDatabase(module.migrations, name);
    await database.ready;
    return {
        database,
        module,
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
            const scope = { agent: { id: agentId } } as Parameters<
                SchedulingModule["tools"]
            >[1];
            const tools = await created.module.tools(created.database.context, scope);
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
});