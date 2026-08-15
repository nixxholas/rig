import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    schedulingAgentIdSchema,
    schedulingCancelInputSchema,
    schedulingDeliveryOutcomeRequestSchema,
    schedulingMessageIdSchema,
    schedulingSchedulePageQuerySchema,
    schedulingSchedulePageSchema,
    schedulingScheduledMessageSchema,
    schedulingTimestampSchema,
    schedulingWaitRecordSchema,
    schedulingWaitSettlementSchema,
    type SchedulingCancelInput,
    type SchedulingScheduledMessage,
    type SchedulingWaitRecord,
    type SchedulingWaitResult,
    type SchedulingWaitSettlement,
} from "./Scheduling.js";

export const schedulingContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

const voidPromiseSchema = Type.Promise(Type.Void());

export const schedulingWaitClaimRequestSchema = Type.Object(
    {
        id: schedulingMessageIdSchema,
        agentId: schedulingAgentIdSchema,
        kind: Type.Union([Type.Literal("wait"), Type.Literal("wait_until")]),
        dueAt: schedulingTimestampSchema,
        startedAt: schedulingTimestampSchema,
    },
    { additionalProperties: false },
);

export const schedulingScheduleRequestSchema = Type.Object(
    {
        id: schedulingMessageIdSchema,
        senderAgentId: schedulingAgentIdSchema,
        targetAgentId: schedulingAgentIdSchema,
        message: Type.String({ minLength: 1, maxLength: 50_000 }),
        dueAt: schedulingTimestampSchema,
    },
    { additionalProperties: false },
);

export const schedulingSchedulerSchema = Type.Object(
    {
        startWait: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingWaitClaimRequestSchema],
            Type.Promise(schedulingWaitRecordSchema),
        ),
        wait: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingMessageIdSchema],
            Type.Promise(schedulingWaitSettlementSchema),
        ),
        schedule: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingScheduleRequestSchema],
            Type.Promise(schedulingScheduledMessageSchema),
        ),
        cancel: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingCancelInputSchema],
            Type.Promise(schedulingScheduledMessageSchema),
        ),
        reportDelivery: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingDeliveryOutcomeRequestSchema,
            ],
            Type.Promise(schedulingScheduledMessageSchema),
        ),
    },
    { additionalProperties: false },
);

const transactionWorkSchema = Type.Function(
    [schedulingContextSchema],
    Type.Promise(Type.Unknown()),
);

export const schedulingStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [schedulingContextSchema, transactionWorkSchema],
            Type.Promise(Type.Unknown()),
        ),
        readWait: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingMessageIdSchema],
            Type.Promise(Type.Union([schedulingWaitRecordSchema, Type.Undefined()])),
        ),
        writeWait: Type.Function(
            [schedulingContextSchema, schedulingWaitRecordSchema],
            voidPromiseSchema,
        ),
        readSchedule: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingMessageIdSchema],
            Type.Promise(Type.Union([schedulingScheduledMessageSchema, Type.Undefined()])),
        ),
        writeSchedule: Type.Function(
            [schedulingContextSchema, schedulingScheduledMessageSchema],
            voidPromiseSchema,
        ),
        listSchedules: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingSchedulePageQuerySchema],
            Type.Promise(schedulingSchedulePageSchema),
        ),
    },
    { additionalProperties: false },
);

type StoredSchedulingStore = Static<typeof schedulingStoreSchema>;
export type SchedulingStore = Omit<StoredSchedulingStore, "transaction"> & {
    readonly transaction: <Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ) => Promise<Result>;
};

export type SchedulingWaitClaimRequest = Static<typeof schedulingWaitClaimRequestSchema>;
export type SchedulingScheduleRequest = Static<typeof schedulingScheduleRequestSchema>;
export type SchedulingDeliveryOutcomeRequest = Static<
    typeof schedulingDeliveryOutcomeRequestSchema
>;
export type SchedulingScheduler = Static<typeof schedulingSchedulerSchema>;

export function assertSchedulingStore(value: unknown): asserts value is SchedulingStore {
    if (!Value.Check(schedulingStoreSchema, value)) {
        throw new Error("Scheduling module received an invalid internal storage adapter.");
    }
}

export function assertSchedulingScheduler(value: unknown): asserts value is SchedulingScheduler {
    if (!Value.Check(schedulingSchedulerSchema, value)) {
        throw new Error("Scheduling module received an invalid host scheduler.");
    }
}

export function assertSchedulingWaitRecord(value: unknown): asserts value is SchedulingWaitRecord {
    if (!Value.Check(schedulingWaitRecordSchema, value)) {
        throw new Error("Scheduling store returned an invalid durable wait.");
    }
    const record = value as SchedulingWaitRecord;
    if (record.createdAt > record.updatedAt || record.startedAt < record.createdAt) {
        throw new Error("Scheduling durable wait has invalid timestamp ordering.");
    }
    if (record.startedAt > record.dueAt) {
        throw new Error("Scheduling durable wait starts after its due time.");
    }
    if (record.status === "waiting") {
        if ("finishedAt" in record || "elapsedMs" in record) {
            throw new Error("Waiting durable wait has terminal fields.");
        }
    } else if (
        record.finishedAt < record.startedAt ||
        record.finishedAt < record.createdAt ||
        record.elapsedMs !== record.finishedAt - record.startedAt ||
        (record.status === "elapsed" && record.finishedAt < record.dueAt)
    ) {
        throw new Error("Scheduling durable wait has an untruthful elapsed duration.");
    }
}

export function assertSchedulingScheduledMessage(
    value: unknown,
): asserts value is SchedulingScheduledMessage {
    if (!Value.Check(schedulingScheduledMessageSchema, value)) {
        throw new Error("Scheduling store returned an invalid scheduled message.");
    }
    const schedule = value as SchedulingScheduledMessage;
    if (schedule.createdAt > schedule.updatedAt || schedule.dueAt < schedule.createdAt) {
        throw new Error("Scheduled message has invalid timestamp ordering.");
    }
    if (schedule.status === "delivered") {
        if (schedule.deliveredAt === undefined || schedule.failure !== undefined) {
            throw new Error("Delivered message has inconsistent delivery fields.");
        }
        if (
            schedule.deliveredAt < schedule.createdAt ||
            schedule.deliveredAt < schedule.dueAt ||
            schedule.deliveredAt > schedule.updatedAt
        ) {
            throw new Error("Delivered message has an invalid delivery timestamp.");
        }
    } else if (schedule.deliveredAt !== undefined) {
        throw new Error("Non-delivered message has deliveredAt.");
    }
    if (schedule.status === "undelivered") {
        if (schedule.failure === undefined || schedule.updatedAt < schedule.dueAt) {
            throw new Error("Undelivered message has invalid failure detail.");
        }
    } else if (schedule.failure !== undefined) {
        throw new Error("Only undelivered messages may include failure detail.");
    }
}

export function assertSchedulingWaitResult(value: unknown): asserts value is SchedulingWaitResult {
    if (!Value.Check(schedulingWaitResultSchema, value)) {
        throw new Error("Scheduling host returned an invalid wait result.");
    }
    const result = value as SchedulingWaitResult;
    if (
        result.endedAt < result.startedAt ||
        result.elapsedMs !== result.endedAt - result.startedAt
    ) {
        throw new Error("Scheduling host returned an untruthful elapsed duration.");
    }
    if (result.outcome === "elapsed" && result.endedAt < result.dueAt) {
        throw new Error("An elapsed wait ended before its requested due time.");
    }
}

export function assertSchedulingCancelInput(
    value: unknown,
): asserts value is SchedulingCancelInput {
    if (!Value.Check(schedulingCancelInputSchema, value)) {
        throw new Error("Scheduling cancellation input is invalid.");
    }
}

export function assertSchedulingSettlement(
    value: unknown,
): asserts value is SchedulingWaitSettlement {
    if (!Value.Check(schedulingWaitSettlementSchema, value)) {
        throw new Error("Scheduling host returned an invalid wait settlement.");
    }
    if (Value.Check(schedulingWaitRecordSchema, value)) assertSchedulingWaitRecord(value);
    else assertSchedulingWaitResult(value);
}

export function assertSchedulingVoid(value: unknown, label: string): asserts value is void {
    if (value !== undefined) throw new Error(`Scheduling ${label} must return void.`);
}