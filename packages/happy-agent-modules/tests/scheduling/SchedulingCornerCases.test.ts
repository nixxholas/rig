import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_SCHEDULING_DETAIL_PAGE_SIZE,
    MAX_SCHEDULING_DURATION_TEXT_LENGTH,
    MAX_SCHEDULING_FAILURE_LENGTH,
    MAX_SCHEDULING_ID_LENGTH,
    MAX_SCHEDULING_MESSAGE_LENGTH,
    MAX_SCHEDULING_PAGE_SIZE,
    MAX_SCHEDULING_TIMESTAMP,
    SchedulingModule,
    assertSchedulingModuleOptions,
    schedulingAgentIdSchema,
    schedulingDeliveryOutcomeInputSchema,
    schedulingDurationSchema,
    schedulingEventSchema,
    schedulingScheduleDetailQuerySchema,
    schedulingScheduleInputSchema,
    schedulingSchedulePageQuerySchema,
    schedulingWaitInputSchema,
    schedulingWaitResultSchema,
} from "../../sources/scheduling/index.js";
import type {
    SchedulingEvent,
    SchedulingScheduledMessage,
    SchedulingWaitRecord,
    SchedulingWaitResult,
} from "../../sources/scheduling/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import {
    InMemorySchedulingScheduler,
    InMemorySchedulingStore,
} from "./support/InMemoryScheduling.js";

const agentId = "agent-a";
const otherAgentId = "agent-b";

interface TestHarness {
    readonly module: SchedulingModule;
    readonly database: ReturnType<typeof moduleDatabase>;
    readonly scheduler: InMemorySchedulingScheduler;
    readonly setNow: (now: number) => void;
}

async function createHarness(
    name: string,
    options: Partial<ConstructorParameters<typeof SchedulingModule>[0]> = {},
): Promise<TestHarness> {
    const scheduler = new InMemorySchedulingScheduler(new InMemorySchedulingStore());
    let now = 1_000;
    let nextId = 0;
    let nextEventId = 0;
    const module = new SchedulingModule({
        scheduler,
        clock: () => now,
        idFactory: () => `generated-${++nextId}`,
        eventIdFactory: () => `event-${++nextEventId}`,
        scheduleMessagePolicy: () => true,
        authorization: () => true,
        ...options,
    });
    const database = moduleDatabase(module.migrations, name);
    await database.ready;
    return {
        module,
        database,
        scheduler,
        setNow: (value) => {
            now = value;
        },
    };
}

function pendingSchedule(
    id: string,
    overrides: Partial<SchedulingScheduledMessage> = {},
): SchedulingScheduledMessage {
    return {
        id,
        senderAgentId: agentId,
        targetAgentId: agentId,
        message: "A scheduled message",
        dueAt: 2_000,
        status: "pending",
        createdAt: 1_000,
        updatedAt: 1_000,
        ...overrides,
    };
}

function waitingRecord(
    id: string,
    overrides: Partial<SchedulingWaitRecord> = {},
): SchedulingWaitRecord {
    return {
        id,
        agentId,
        kind: "wait",
        dueAt: 2_000,
        createdAt: 1_000,
        updatedAt: 1_000,
        startedAt: 1_000,
        status: "waiting",
        ...overrides,
    } as SchedulingWaitRecord;
}

function elapsedResult(
    waitId: string,
    overrides: Partial<SchedulingWaitResult> = {},
): SchedulingWaitResult {
    return {
        waitId,
        agentId,
        outcome: "elapsed",
        kind: "wait",
        dueAt: 2_000,
        startedAt: 1_000,
        endedAt: 2_000,
        elapsedMs: 1_000,
        ...overrides,
    };
}

async function insertSchedule(
    database: ReturnType<typeof moduleDatabase>,
    schedule: unknown,
): Promise<void> {
    await agentDatabaseRun(
        database.database,
        sql`INSERT INTO happy_scheduling_schedules
            (id, sender_agent_id, target_agent_id, due_at, status, schedule_json)
            VALUES (
                ${(schedule as { id: string }).id},
                ${(schedule as { senderAgentId: string }).senderAgentId},
                ${(schedule as { targetAgentId: string }).targetAgentId},
                ${(schedule as { dueAt: number }).dueAt},
                ${(schedule as { status: string }).status},
                ${JSON.stringify(schedule)}
            )`,
    );
}

async function insertWait(
    database: ReturnType<typeof moduleDatabase>,
    wait: unknown,
): Promise<void> {
    await agentDatabaseRun(
        database.database,
        sql`INSERT INTO happy_scheduling_waits
            (id, agent_id, record_json)
            VALUES (
                ${(wait as { id: string }).id},
                ${(wait as { agentId: string }).agentId},
                ${JSON.stringify(wait)}
            )`,
    );
}

describe("Scheduling schemas and persistence boundaries", () => {
    it("accepts legal maximum identities and rejects malformed identity boundaries", () => {
        const maxId = `a${"x".repeat(MAX_SCHEDULING_ID_LENGTH - 1)}`;
        expect(Value.Check(schedulingAgentIdSchema, maxId)).toBe(true);
        for (const invalid of [
            "",
            ` ${maxId}`,
            `${maxId}x`,
            "agent/child",
            "agent\\child",
            "agent with spaces",
            "é",
            1,
            null,
        ]) {
            expect(Value.Check(schedulingAgentIdSchema, invalid)).toBe(false);
        }
    });

    it("enforces all bounded schema leaves and rejects unknown nested keys", () => {
        expect(
            Value.Check(schedulingDurationSchema, "x".repeat(MAX_SCHEDULING_DURATION_TEXT_LENGTH)),
        ).toBe(true);
        expect(
            Value.Check(
                schedulingDurationSchema,
                "x".repeat(MAX_SCHEDULING_DURATION_TEXT_LENGTH + 1),
            ),
        ).toBe(false);
        expect(
            Value.Check(schedulingScheduleInputSchema, {
                id: "schedule1",
                message: "x".repeat(MAX_SCHEDULING_MESSAGE_LENGTH),
                in: { seconds: 0 },
            }),
        ).toBe(true);
        expect(
            Value.Check(schedulingScheduleInputSchema, {
                id: "schedule1",
                message: "x".repeat(MAX_SCHEDULING_MESSAGE_LENGTH + 1),
                in: { seconds: 0 },
            }),
        ).toBe(false);
        expect(
            Value.Check(schedulingScheduleInputSchema, {
                id: "schedule1",
                message: "hello",
                in: { seconds: 0, unexpected: true },
            }),
        ).toBe(false);
        expect(
            Value.Check(schedulingDeliveryOutcomeInputSchema, {
                scheduleId: "schedule1",
                status: "undelivered",
                failure: "x".repeat(MAX_SCHEDULING_FAILURE_LENGTH),
            }),
        ).toBe(true);
        expect(
            Value.Check(schedulingDeliveryOutcomeInputSchema, {
                scheduleId: "schedule1",
                status: "undelivered",
                failure: "x".repeat(MAX_SCHEDULING_FAILURE_LENGTH + 1),
            }),
        ).toBe(false);
    });

    it("rejects invalid module options before opening module state", () => {
        const scheduler = new InMemorySchedulingScheduler(new InMemorySchedulingStore());
        const invalid = [
            {},
            { scheduler: { ...scheduler, wait: undefined } },
            { scheduler, maxPageSize: 0 },
            { scheduler, maxPageSize: MAX_SCHEDULING_PAGE_SIZE + 1 },
            { scheduler, maxOutputCharacters: 255 },
            { scheduler, maxMessageLength: MAX_SCHEDULING_MESSAGE_LENGTH + 1 },
            { scheduler, maxWaitDuration: MAX_SCHEDULING_TIMESTAMP + 1 },
            { scheduler, maxScheduleHorizon: MAX_SCHEDULING_TIMESTAMP + 1 },
            { scheduler, unknown: true },
        ];
        for (const value of invalid) {
            expect(() => assertSchedulingModuleOptions(value)).toThrow(
                "Scheduling module options are invalid",
            );
        }
    });

    it("rejects malformed persisted JSON and semantically invalid persisted records", async () => {
        const malformedJson = await createHarness("scheduling-malformed-json");
        try {
            await agentDatabaseRun(
                malformedJson.database.database,
                sql`INSERT INTO happy_scheduling_schedules
                    (id, sender_agent_id, target_agent_id, due_at, status, schedule_json)
                    VALUES (${"bad-json"}, ${agentId}, ${agentId}, ${2_000}, ${"pending"}, ${"{"})`,
            );
            await expect(
                malformedJson.module.getSchedule(
                    malformedJson.database.context,
                    agentId,
                    "bad-json",
                ),
            ).rejects.toThrow("invalid JSON");
        } finally {
            malformedJson.database.close();
        }

        const malformedRecord = await createHarness("scheduling-malformed-record");
        try {
            await insertSchedule(
                malformedRecord.database,
                pendingSchedule("bad-record", {
                    status: "delivered",
                }),
            );
            await expect(
                malformedRecord.module.getSchedule(
                    malformedRecord.database.context,
                    agentId,
                    "bad-record",
                ),
            ).rejects.toThrow("inconsistent delivery fields");
        } finally {
            malformedRecord.database.close();
        }

        const malformedWait = await createHarness("scheduling-malformed-wait");
        try {
            await insertWait(
                malformedWait.database,
                waitingRecord("bad-wait", {
                    status: "elapsed",
                    finishedAt: 2_000,
                    elapsedMs: 0,
                }),
            );
            await expect(
                malformedWait.module.wait(malformedWait.database.context, agentId, {
                    id: "bad-wait",
                    duration: { seconds: 1 },
                }),
            ).rejects.toThrow("untruthful elapsed duration");
        } finally {
            malformedWait.database.close();
        }
    });

    it("survives a fresh module instance and preserves list ordering and filters", async () => {
        const first = await createHarness("scheduling-reload");
        try {
            await first.module.schedule(first.database.context, agentId, {
                id: "later",
                message: "later",
                in: { seconds: 5 },
            });
            await first.module.schedule(first.database.context, agentId, {
                id: "earlier",
                message: "earlier",
                in: { seconds: 1 },
            });
            await first.module.schedule(first.database.context, otherAgentId, {
                id: "other-agent",
                message: "other",
                in: { seconds: 1 },
            });

            const reloadedScheduler = new InMemorySchedulingScheduler(
                new InMemorySchedulingStore(),
            );
            const reloaded = new SchedulingModule({
                scheduler: reloadedScheduler,
                clock: () => 1_000,
                scheduleMessagePolicy: () => true,
                authorization: () => true,
            });
            const page = await reloaded.listSchedulePage(first.database.context, agentId, {
                limit: 10,
            });
            expect(page.schedules.map(({ id }) => id)).toEqual(["earlier", "later"]);
            await expect(
                reloaded.getSchedule(first.database.context, agentId, "earlier"),
            ).resolves.toMatchObject({ message: "earlier" });
            await expect(
                reloaded.getSchedule(first.database.context, agentId, "other-agent"),
            ).resolves.toBeUndefined();
        } finally {
            first.database.close();
        }
    });
});

describe("Scheduling waits and schedule transitions", () => {
    it("persists elapsed and interrupted outcomes and makes terminal waits replayable", async () => {
        const test = await createHarness("scheduling-wait-replay");
        try {
            const elapsed = test.module.wait(test.database.context, agentId, {
                id: "wait-elapsed",
                duration: { seconds: 1 },
            });
            await test.scheduler.waitStartedFor("wait-elapsed");
            test.setNow(2_000);
            test.scheduler.settle("wait-elapsed", elapsedResult("wait-elapsed"));
            await expect(elapsed).resolves.toMatchObject({
                waitId: "wait-elapsed",
                outcome: "elapsed",
                elapsedMs: 1_000,
            });
            await expect(
                test.module.wait(test.database.context, agentId, {
                    id: "wait-elapsed",
                    duration: { seconds: 1 },
                }),
            ).resolves.toMatchObject({ waitId: "wait-elapsed", outcome: "elapsed" });

            test.setNow(1_500);
            const interrupted = test.module.wait(test.database.context, agentId, {
                id: "wait-interrupted",
                duration: { seconds: 10 },
            });
            await test.scheduler.waitStartedFor("wait-interrupted");
            test.scheduler.settle(
                "wait-interrupted",
                elapsedResult("wait-interrupted", {
                    outcome: "interrupted",
                    dueAt: 11_500,
                    startedAt: 1_500,
                    endedAt: 1_600,
                    elapsedMs: 100,
                }),
            );
            test.setNow(1_600);
            await expect(interrupted).resolves.toMatchObject({
                waitId: "wait-interrupted",
                outcome: "interrupted",
            });
        } finally {
            test.database.close();
        }
    });

    it("rejects a wait retry whose same ID changes its requested timing", async () => {
        const test = await createHarness("scheduling-wait-fingerprint");
        try {
            await insertWait(
                test.database,
                waitingRecord("wait-fingerprint", {
                    dueAt: 11_000,
                }),
            );
            test.setNow(11_000);
            test.scheduler.wait = async () =>
                elapsedResult("wait-fingerprint", {
                    dueAt: 11_000,
                    endedAt: 11_000,
                    elapsedMs: 10_000,
                });
            await expect(
                test.module.wait(test.database.context, agentId, {
                    id: "wait-fingerprint",
                    duration: { seconds: 20 },
                }),
            ).rejects.toThrow("does not match");
        } finally {
            test.database.close();
        }
    });

    it("rejects malformed host wait settlements and settlement identity mismatches", async () => {
        const malformed = await createHarness("scheduling-wait-host-validation");
        try {
            malformed.scheduler.wait = async (_ctx, _agent, waitId) => {
                return {
                    ...elapsedResult(waitId),
                    elapsedMs: 2,
                };
            };
            const pending = malformed.module.wait(malformed.database.context, agentId, {
                id: "wait-invalid-result",
                duration: { seconds: 1 },
            });
            await expect(pending).rejects.toThrow("untruthful elapsed duration");
        } finally {
            malformed.database.close();
        }

        const mismatched = await createHarness("scheduling-wait-host-identity");
        try {
            mismatched.scheduler.wait = async () => {
                return elapsedResult("another-wait");
            };
            const pending = mismatched.module.wait(mismatched.database.context, agentId, {
                id: "wait-identity",
                duration: { seconds: 1 },
            });
            await expect(pending).rejects.toThrow("belongs to another durable wait");
        } finally {
            mismatched.database.close();
        }
    });

    it("enforces duration, instant, message, and detail bounds at public boundaries", async () => {
        const test = await createHarness("scheduling-bounds", {
            maxWaitDuration: 1_000,
            maxScheduleHorizon: 1_000,
            maxMessageLength: 3,
        });
        try {
            await expect(
                test.module.wait(test.database.context, agentId, {
                    id: "too-long-wait",
                    duration: { seconds: 2 },
                }),
            ).rejects.toThrow("cannot exceed");
            await expect(
                test.module.waitUntil(test.database.context, agentId, {
                    id: "too-far",
                    at: 10_000,
                }),
            ).rejects.toThrow("more than");
            await expect(
                test.module.schedule(test.database.context, agentId, {
                    id: "too-long-message",
                    message: "four",
                    in: { seconds: 0 },
                }),
            ).rejects.toThrow("exceeds 3");
            await expect(
                test.module.schedule(test.database.context, agentId, {
                    id: "too-far-schedule",
                    message: "ok",
                    in: { seconds: 2 },
                }),
            ).rejects.toThrow("cannot exceed");
            await expect(
                test.module.getSchedulePage(test.database.context, agentId, "missing", {
                    detailLimit: MAX_SCHEDULING_DETAIL_PAGE_SIZE + 1,
                }),
            ).rejects.toThrow("invalid");
        } finally {
            test.database.close();
        }
    });

    it("contains scheduler failures without persisting partial catalog state", async () => {
        const test = await createHarness("scheduling-scheduler-failure");
        try {
            test.scheduler.schedule = async () => {
                throw new Error("host schedule unavailable");
            };
            await expect(
                test.module.schedule(test.database.context, agentId, {
                    id: "host-failure",
                    message: "do not persist",
                    in: { seconds: 0 },
                }),
            ).rejects.toThrow("host schedule unavailable");
            await expect(
                test.module.getSchedule(test.database.context, agentId, "host-failure"),
            ).resolves.toBeUndefined();
        } finally {
            test.database.close();
        }
    });

    it("validates delivery and cancellation transitions from the host", async () => {
        const test = await createHarness("scheduling-transition-validation");
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "cancel-me",
                message: "cancel",
                in: { seconds: 1 },
            });
            await expect(
                test.module.cancelSchedule(test.database.context, agentId, {
                    scheduleId: "cancel-me",
                }),
            ).resolves.toMatchObject({ status: "cancelled" });
            await expect(
                test.module.reportDeliveryOutcome(test.database.context, agentId, {
                    scheduleId: "cancel-me",
                    status: "delivered",
                }),
            ).resolves.toMatchObject({ status: "cancelled" });

            await test.module.schedule(test.database.context, agentId, {
                id: "deliver-me",
                message: "deliver",
                in: { seconds: 1 },
            });
            await expect(
                test.module.reportDeliveryOutcome(test.database.context, agentId, {
                    scheduleId: "deliver-me",
                    status: "delivered",
                    deliveredAt: 2_000,
                }),
            ).resolves.toMatchObject({ status: "delivered", deliveredAt: 2_000 });
            await expect(
                test.module.reportDeliveryOutcome(test.database.context, agentId, {
                    scheduleId: "deliver-me",
                    status: "undelivered",
                    failure: "late",
                }),
            ).resolves.toMatchObject({ status: "delivered" });
        } finally {
            test.database.close();
        }
    });
});

describe("Scheduling listeners, transactions, authorization, and tools", () => {
    it("delivers one stable deeply frozen event to both listeners", async () => {
        const transactional: SchedulingEvent[] = [];
        const postCommit: SchedulingEvent[] = [];
        const test = await createHarness("scheduling-events", {
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
            await test.module.schedule(test.database.context, agentId, {
                id: "event-schedule",
                message: "event",
                in: { seconds: 1 },
            });
            expect(transactional).toHaveLength(1);
            expect(postCommit).toHaveLength(1);
            expect(postCommit[0]).toBe(transactional[0]);
            expect(Object.isFrozen(transactional[0])).toBe(true);
            expect(
                Object.isFrozen(
                    (transactional[0] as Extract<SchedulingEvent, { type: "message_scheduled" }>)
                        .schedule,
                ),
            ).toBe(true);
            expect(Value.Check(schedulingEventSchema, transactional[0])).toBe(true);
        } finally {
            test.database.close();
        }
    });

    it("does not publish post-commit events or durable rows after an outer rollback", async () => {
        const postCommit = vi.fn();
        const test = await createHarness("scheduling-outer-rollback", {
            listener: { onEvent: postCommit },
        });
        try {
            await expect(
                test.database.context.inTx(async (txCtx) => {
                    await test.module.schedule(txCtx, agentId, {
                        id: "rolled-back-schedule",
                        message: "rollback",
                        in: { seconds: 1 },
                    });
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");
            expect(postCommit).not.toHaveBeenCalled();
            await expect(
                test.module.getSchedule(test.database.context, agentId, "rolled-back-schedule"),
            ).resolves.toBeUndefined();
        } finally {
            test.database.close();
        }
    });

    it("reports post-commit listener failures without failing the committed mutation", async () => {
        const onPostCommitError = vi.fn();
        const test = await createHarness("scheduling-post-commit-error", {
            listener: {
                onEvent: () => {
                    throw new Error("observer failed");
                },
            },
            onPostCommitError,
        });
        try {
            await expect(
                test.module.schedule(test.database.context, agentId, {
                    id: "observer-error",
                    message: "committed",
                    in: { seconds: 1 },
                }),
            ).resolves.toMatchObject({ id: "observer-error" });
            expect(onPostCommitError).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ eventId: "event-1" }),
                "observer failed",
            );
        } finally {
            test.database.close();
        }
    });

    it("reports a bounded fallback for a post-commit listener throwing a hostile value", async () => {
        const onPostCommitError = vi.fn();
        const test = await createHarness("scheduling-hostile-error", {
            listener: {
                onEvent: () => {
                    throw {
                        toString: () => {
                            throw new Error("cannot stringify");
                        },
                    };
                },
            },
            onPostCommitError,
        });
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "hostile-error",
                message: "committed",
                in: { seconds: 1 },
            });
            expect(onPostCommitError).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ eventId: "event-1" }),
                "Unknown scheduling observer error.",
            );
        } finally {
            test.database.close();
        }
    });

    it("keeps external scheduler calls outside an outer database transaction", async () => {
        const test = await createHarness("scheduling-external-boundary");
        try {
            const seenDatabases: unknown[] = [];
            const original = test.scheduler.schedule.bind(test.scheduler);
            test.scheduler.schedule = async (ctx, actingAgentId, request) => {
                seenDatabases.push(ctx.db);
                return await original(ctx, actingAgentId, request);
            };
            await test.database.context.inTx(async (txCtx) => {
                await test.module.schedule(txCtx, agentId, {
                    id: "outer-schedule",
                    message: "outside",
                    in: { seconds: 1 },
                });
            });
            expect(seenDatabases).toEqual([test.database.database]);
        } finally {
            test.database.close();
        }
    });

    it("denies cross-agent reads and writes unless the injected policy authorizes each action", async () => {
        const denied = await createHarness("scheduling-authorization-denied", {
            authorization: undefined as never,
        });
        try {
            await expect(
                denied.module.schedule(denied.database.context, agentId, {
                    id: "cross-agent",
                    targetAgentId: otherAgentId,
                    message: "cross",
                    in: { seconds: 1 },
                }),
            ).rejects.toThrow("not authorized");
        } finally {
            denied.database.close();
        }

        const authorizationCalls: Array<{
            readonly acting: string;
            readonly target: string;
            readonly action: string;
        }> = [];
        const test = await createHarness("scheduling-authorization", {
            authorization: async (_ctx, acting, target, action) => {
                authorizationCalls.push({ acting, target, action });
                return true;
            },
        });
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "cross-agent",
                targetAgentId: otherAgentId,
                message: "cross",
                in: { seconds: 1 },
            });
            await expect(
                test.module.getSchedule(test.database.context, otherAgentId, "cross-agent"),
            ).resolves.toMatchObject({ targetAgentId: otherAgentId });
            await expect(
                test.module.cancelSchedule(test.database.context, otherAgentId, {
                    scheduleId: "cross-agent",
                }),
            ).resolves.toMatchObject({ status: "cancelled" });
            expect(authorizationCalls).toEqual(
                expect.arrayContaining([
                    { acting: agentId, target: otherAgentId, action: "schedule" },
                    { acting: otherAgentId, target: agentId, action: "read" },
                    { acting: otherAgentId, target: agentId, action: "cancel" },
                ]),
            );
        } finally {
            test.database.close();
        }
    });

    it("uses one implementation for public and model-facing schedule operations", async () => {
        const test = await createHarness("scheduling-tool-parity");
        try {
            const hooks = await resolveModuleHooks(test.database.context, test.module, undefined);
            const tools = await hooks.tools!(test.database.context, {
                agent: { id: agentId },
            } as never);
            const scheduleTool = tools.find((tool) => tool.name === "schedule_message");
            expect(scheduleTool).toBeDefined();
            expect(scheduleTool?.durable).toBe(true);
            expect(scheduleTool?.transactional).not.toBe(true);
            expect(
                Value.Check(scheduleTool!.parameters, {
                    input: {
                        agent_id: agentId,
                        message: "tool parity",
                        in: { seconds: 1 },
                    },
                }),
            ).toBe(true);
            await expect(
                scheduleTool!.execute(
                    test.database.context,
                    {
                        input: {
                            agent_id: agentId,
                            message: "tool parity",
                            in: { seconds: 1 },
                        },
                    },
                    { id: "tool-schedule", providerCallId: "provider", kv: {} } as never,
                ),
            ).resolves.toMatchObject({ id: "tool-schedule", senderAgentId: agentId });
        } finally {
            test.database.close();
        }
    });

    it("allocates durable tool identities independently of provider call IDs", async () => {
        const test = await createHarness("scheduling-tool-identity");
        try {
            const hooks = await resolveModuleHooks(test.database.context, test.module);
            const tools = await hooks.tools!(test.database.context, {
                agent: { id: agentId },
            } as never);
            const scheduleTool = tools.find((tool) => tool.name === "schedule_message");
            const result = await scheduleTool!.execute(
                test.database.context,
                {
                    input: {
                        agent_id: agentId,
                        message: "provider ID must not be the record ID",
                        in: { seconds: 1 },
                    },
                },
                { id: "provider-call-identity", providerCallId: "provider", kv: {} } as never,
            );
            expect(result.id).toBe("generated-1");
        } finally {
            test.database.close();
        }
    });

    it("replays an identical durable schedule tool call without duplicating state or events", async () => {
        const events: SchedulingEvent[] = [];
        const test = await createHarness("scheduling-tool-replay", {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        try {
            const hooks = await resolveModuleHooks(test.database.context, test.module);
            const scheduleTool = (
                await hooks.tools!(test.database.context, { agent: { id: agentId } } as never)
            ).find((tool) => tool.name === "schedule_message")!;
            const args = {
                input: {
                    agent_id: agentId,
                    message: "replay me",
                    in: { seconds: 1 },
                },
            };
            const call = {
                id: "replay-call",
                providerCallId: "provider",
                kv: {},
            } as never;
            const first = await scheduleTool.execute(test.database.context, args, call);
            const second = await scheduleTool.execute(test.database.context, args, call);
            expect(second).toEqual(first);
            expect(events.filter((event) => event.type === "message_scheduled")).toHaveLength(1);
            expect(test.scheduler.calls.filter((callName) => callName === "schedule")).toHaveLength(
                1,
            );
        } finally {
            test.database.close();
        }
    });
});

describe("Scheduling paging and model output", () => {
    it("enforces store page limits, cursor progression, and previous-page links", async () => {
        const test = await createHarness("scheduling-pages", { maxPageSize: 2 });
        try {
            for (const [id, seconds] of [
                ["page-a", 1],
                ["page-b", 2],
                ["page-c", 3],
            ] as const) {
                await test.module.schedule(test.database.context, agentId, {
                    id,
                    message: id,
                    in: { seconds },
                });
            }
            const first = await test.module.listSchedulePage(test.database.context, agentId, {
                limit: 2,
            });
            expect(first.schedules.map(({ id }) => id)).toEqual(["page-a", "page-b"]);
            expect(first.nextCursor).toBe("2");
            if (first.nextCursor === undefined) throw new Error("Expected a next cursor.");
            const last = await test.module.listSchedulePage(test.database.context, agentId, {
                limit: 2,
                cursor: first.nextCursor,
            });
            expect(last.schedules.map(({ id }) => id)).toEqual(["page-c"]);
            expect(last.previousCursor).toBe("0");
            expect(last.nextCursor).toBeUndefined();
        } finally {
            test.database.close();
        }
    });

    it("keeps a previous cursor visible when formatting an empty page beyond the end", async () => {
        const test = await createHarness("scheduling-empty-page-output");
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "visible-before-empty",
                message: "visible",
                in: { seconds: 1 },
            });
            const page = await test.module.listSchedulePage(test.database.context, agentId, {
                limit: 1,
                cursor: "99",
            });
            expect(page.schedules).toEqual([]);
            expect(page.previousCursor).toBe("98");
            expect(test.module.formatSchedulePageForModel(page)).toContain(
                "Earlier scheduled messages",
            );
        } finally {
            test.database.close();
        }
    });

    it("keeps detail pages bounded and exposes a valid continuation", async () => {
        const test = await createHarness("scheduling-detail-output", {
            maxOutputCharacters: 256,
        });
        try {
            await test.module.schedule(test.database.context, agentId, {
                id: "detail-output",
                message: "x".repeat(2_000),
                in: { seconds: 1 },
            });
            const page = await test.module.getSchedulePage(
                test.database.context,
                agentId,
                "detail-output",
                { detailLimit: 1_000 },
            );
            expect(page.nextDetailOffset).toBeDefined();
            const formatted = test.module.formatScheduleDetailPageForModel(page);
            expect(formatted.length).toBeLessThanOrEqual(256);
            expect(formatted).toContain("detail-output");
        } finally {
            test.database.close();
        }
    });

    it("rejects formatter inputs that violate the public page schemas", async () => {
        const test = await createHarness("scheduling-format-validation");
        try {
            expect(() =>
                test.module.formatSchedulePageForModel({
                    schedules: [
                        pendingSchedule("bad", {
                            dueAt: "bad" as never,
                        }) as never,
                    ],
                    limit: 1,
                }),
            ).toThrow("invalid schedule page");
            expect(() =>
                test.module.formatScheduleDetailPageForModel({
                    schedule: null,
                    detail: "",
                    detailOffset: -1 as never,
                    detailTotal: 0,
                }),
            ).toThrow("invalid schedule detail");
            expect(Value.Check(schedulingSchedulePageQuerySchema, { limit: 0 })).toBe(false);
            expect(Value.Check(schedulingScheduleDetailQuerySchema, { detailOffset: -1 })).toBe(
                false,
            );
            expect(Value.Check(schedulingWaitInputSchema, { seconds: 0 })).toBe(true);
            expect(Value.Check(schedulingWaitResultSchema, elapsedResult("wait"))).toBe(true);
        } finally {
            test.database.close();
        }
    });
});
