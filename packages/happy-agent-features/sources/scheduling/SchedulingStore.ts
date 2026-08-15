import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    schedulingAgentIdSchema,
    schedulingCancelInputSchema,
    schedulingDeliveryOutcomeRequestSchema,
    schedulingFingerprintSchema,
    schedulingMessageIdSchema,
    schedulingOperationIdSchema,
    schedulingScheduleInputSchema,
    schedulingSchedulePageQuerySchema,
    schedulingSchedulePageSchema,
    schedulingScheduledMessageSchema,
    schedulingTimestampSchema,
    schedulingWaitRecordSchema,
    schedulingWaitResultSchema,
    schedulingWaitSettlementSchema,
    type SchedulingCancelInput,
    type SchedulingFingerprint,
    type SchedulingScheduleInput,
    type SchedulingScheduledMessage,
    type SchedulingWaitRecord,
    type SchedulingWaitResult,
    type SchedulingWaitSettlement,
} from "./Scheduling.js";
import { schedulingEventSchema } from "./SchedulingEvent.js";

export const schedulingContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

const voidPromiseSchema = Type.Promise(Type.Void());
const postCommitCallbackSchema = Type.Function(
    [schedulingContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export const schedulingMutationKindSchema = Type.Union([
    Type.Literal("wait"),
    Type.Literal("schedule"),
    Type.Literal("cancel"),
    Type.Literal("delivery"),
]);

export const schedulingMutationResultSchema = Type.Union([
    schedulingWaitRecordSchema,
    schedulingWaitResultSchema,
    schedulingScheduledMessageSchema,
]);

const schedulingTransactionChangeCommon = {
    operationId: schedulingOperationIdSchema,
    actingAgentId: schedulingAgentIdSchema,
    changed: Type.Boolean(),
    events: Type.Array(schedulingEventSchema, { maxItems: 4 }),
};

/**
 * These variants intentionally repeat the shared fields. The kind/result pairing is a public
 * durable contract, so a broad object with a later handwritten assertion is not sufficient.
 */
export const schedulingTransactionChangeSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("wait"),
            ...schedulingTransactionChangeCommon,
            result: Type.Union([schedulingWaitRecordSchema, schedulingWaitResultSchema]),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Union([
                Type.Literal("schedule"),
                Type.Literal("cancel"),
                Type.Literal("delivery"),
            ]),
            ...schedulingTransactionChangeCommon,
            result: schedulingScheduledMessageSchema,
        },
        { additionalProperties: false },
    ),
]);

export const schedulingMutationReceiptSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("wait"),
            operationId: schedulingOperationIdSchema,
            actingAgentId: schedulingAgentIdSchema,
            fingerprint: schedulingFingerprintSchema,
            result: schedulingWaitResultSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Union([
                Type.Literal("schedule"),
                Type.Literal("cancel"),
                Type.Literal("delivery"),
            ]),
            operationId: schedulingOperationIdSchema,
            actingAgentId: schedulingAgentIdSchema,
            fingerprint: schedulingFingerprintSchema,
            result: schedulingScheduledMessageSchema,
        },
        { additionalProperties: false },
    ),
]);

export const schedulingMutationProofSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("wait"),
            operationId: schedulingOperationIdSchema,
            actingAgentId: schedulingAgentIdSchema,
            fingerprint: schedulingFingerprintSchema,
            subjectId: schedulingMessageIdSchema,
            before: Type.Union([schedulingWaitRecordSchema, Type.Null()]),
            after: schedulingWaitRecordSchema,
            changed: Type.Boolean(),
            result: schedulingWaitResultSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Union([
                Type.Literal("schedule"),
                Type.Literal("cancel"),
                Type.Literal("delivery"),
            ]),
            operationId: schedulingOperationIdSchema,
            actingAgentId: schedulingAgentIdSchema,
            fingerprint: schedulingFingerprintSchema,
            subjectId: schedulingMessageIdSchema,
            before: Type.Union([schedulingScheduledMessageSchema, Type.Null()]),
            after: schedulingScheduledMessageSchema,
            changed: Type.Boolean(),
            result: schedulingScheduledMessageSchema,
        },
        { additionalProperties: false },
    ),
]);

export const schedulingMutationRequestSchema = Type.Object(
    {
        kind: schedulingMutationKindSchema,
        operationId: schedulingOperationIdSchema,
        fingerprint: schedulingFingerprintSchema,
    },
    { additionalProperties: false },
);

export const schedulingWaitClaimRequestSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 128 }),
        agentId: schedulingAgentIdSchema,
        operationId: schedulingOperationIdSchema,
        fingerprint: schedulingFingerprintSchema,
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
        operationId: schedulingOperationIdSchema,
        fingerprint: schedulingFingerprintSchema,
    },
    { additionalProperties: false },
);

export const schedulingSchedulerSchema = Type.Object(
    {
        startWait: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingWaitClaimRequestSchema,
            ],
            Type.Promise(schedulingWaitRecordSchema),
        ),
        wait: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                Type.String({ minLength: 1, maxLength: 128 }),
            ],
            Type.Promise(schedulingWaitSettlementSchema),
        ),
        schedule: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingScheduleRequestSchema,
            ],
            Type.Promise(schedulingScheduledMessageSchema),
        ),
        cancel: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingCancelInputSchema,
            ],
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

export const schedulingStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                Type.Function(
                    [schedulingContextSchema],
                    Type.Promise(schedulingTransactionChangeSchema),
                ),
            ],
            Type.Promise(schedulingTransactionChangeSchema),
        ),
        afterCommit: Type.Function(
            [schedulingContextSchema, postCommitCallbackSchema],
            Type.Void(),
        ),
        readWait: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                Type.String({ minLength: 1, maxLength: 128 }),
            ],
            Type.Promise(Type.Union([schedulingWaitRecordSchema, Type.Undefined()])),
        ),
        writeWait: Type.Function(
            [schedulingContextSchema, schedulingWaitRecordSchema],
            voidPromiseSchema,
        ),
        readSchedule: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingMessageIdSchema,
            ],
            Type.Promise(Type.Union([schedulingScheduledMessageSchema, Type.Undefined()])),
        ),
        writeSchedule: Type.Function(
            [schedulingContextSchema, schedulingScheduledMessageSchema],
            voidPromiseSchema,
        ),
        listSchedules: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingSchedulePageQuerySchema,
            ],
            Type.Promise(schedulingSchedulePageSchema),
        ),
        readReceipt: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingOperationIdSchema,
            ],
            Type.Promise(
                Type.Union([schedulingMutationReceiptSchema, Type.Undefined()]),
            ),
        ),
        writeReceipt: Type.Function(
            [schedulingContextSchema, schedulingMutationReceiptSchema],
            voidPromiseSchema,
        ),
        readMutationProof: Type.Function(
            [
                schedulingContextSchema,
                schedulingAgentIdSchema,
                schedulingOperationIdSchema,
            ],
            Type.Promise(Type.Union([schedulingMutationProofSchema, Type.Undefined()])),
        ),
        writeMutationProof: Type.Function(
            [schedulingContextSchema, schedulingMutationProofSchema],
            voidPromiseSchema,
        ),
    },
    { additionalProperties: false },
);

export type SchedulingMutationKind = Static<typeof schedulingMutationKindSchema>;
export type SchedulingMutationResult = Static<typeof schedulingMutationResultSchema>;
export type SchedulingTransactionChange = Static<typeof schedulingTransactionChangeSchema>;
export type SchedulingMutationReceipt = Static<typeof schedulingMutationReceiptSchema>;
export type SchedulingMutationProof = Static<typeof schedulingMutationProofSchema>;
export type SchedulingMutationRequest = Static<typeof schedulingMutationRequestSchema>;
export type SchedulingWaitClaimRequest = Static<typeof schedulingWaitClaimRequestSchema>;
export type SchedulingScheduleRequest = Static<typeof schedulingScheduleRequestSchema>;
export type SchedulingDeliveryOutcomeRequest = Static<
    typeof schedulingDeliveryOutcomeRequestSchema
>;
export type SchedulingScheduler = Static<typeof schedulingSchedulerSchema>;
export type SchedulingStore = Static<typeof schedulingStoreSchema>;

export function assertSchedulingStore(value: unknown): asserts value is SchedulingStore {
    if (!Value.Check(schedulingStoreSchema, value)) {
        throw new Error("Scheduling feature received an invalid host store.");
    }
}

export function assertSchedulingScheduler(value: unknown): asserts value is SchedulingScheduler {
    if (!Value.Check(schedulingSchedulerSchema, value)) {
        throw new Error("Scheduling feature received an invalid host scheduler.");
    }
}

export function assertSchedulingTransactionChange(
    value: unknown,
): asserts value is SchedulingTransactionChange {
    if (!Value.Check(schedulingTransactionChangeSchema, value)) {
        throw new Error("Scheduling store transaction returned an invalid change.");
    }
    const change = value as SchedulingTransactionChange;
    if (change.kind === "wait") {
        if (
            !Value.Check(schedulingWaitRecordSchema, change.result) &&
            !Value.Check(schedulingWaitResultSchema, change.result)
        ) {
            throw new Error("Scheduling wait transaction returned a non-wait result.");
        }
    } else {
        assertSchedulingScheduledMessage(change.result);
    }
}

export function assertSchedulingMutationReceipt(
    value: unknown,
): asserts value is SchedulingMutationReceipt {
    if (!Value.Check(schedulingMutationReceiptSchema, value)) {
        throw new Error("Scheduling store returned an invalid mutation receipt.");
    }
    const receipt = value as SchedulingMutationReceipt;
    if (receipt.kind === "wait") assertSchedulingWaitResult(receipt.result);
    else assertSchedulingScheduledMessage(receipt.result);
}

export function assertSchedulingMutationProof(
    value: unknown,
): asserts value is SchedulingMutationProof {
    if (!Value.Check(schedulingMutationProofSchema, value)) {
        throw new Error("Scheduling store returned an invalid immutable mutation proof.");
    }
    const proof = value as SchedulingMutationProof;
    if (proof.kind === "wait") {
        if (proof.before !== null) {
            assertSchedulingWaitRecord(proof.before);
        }
        assertSchedulingWaitRecord(proof.after);
        assertSchedulingWaitResult(proof.result);
    } else {
        if (proof.before !== null) {
            assertSchedulingScheduledMessage(proof.before);
        }
        assertSchedulingScheduledMessage(proof.after);
        assertSchedulingScheduledMessage(proof.result);
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
    if (schedule.createdAt > schedule.updatedAt) {
        throw new Error("Scheduled message has invalid timestamp ordering.");
    }
    if (schedule.dueAt < schedule.createdAt) {
        throw new Error("Scheduled message is due before it was created.");
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
        if (schedule.failure === undefined) {
            throw new Error("Undelivered message must include bounded failure detail.");
        }
        if (schedule.updatedAt < schedule.dueAt) {
            throw new Error("Undelivered message was recorded before its due time.");
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
    if (result.endedAt < result.startedAt || result.elapsedMs !== result.endedAt - result.startedAt) {
        throw new Error("Scheduling host returned an untruthful elapsed duration.");
    }
    if (result.outcome === "elapsed" && result.endedAt < result.dueAt) {
        throw new Error("An elapsed wait ended before its requested due time.");
    }
}

export function assertSchedulingCancelInput(value: unknown): asserts value is SchedulingCancelInput {
    if (!Value.Check(schedulingCancelInputSchema, value)) {
        throw new Error("Scheduling cancellation input is invalid.");
    }
}

export function assertSchedulingFingerprint(value: unknown): asserts value is SchedulingFingerprint {
    if (!Value.Check(schedulingFingerprintSchema, value)) {
        throw new Error("Scheduling fingerprint is invalid.");
    }
}

export function assertSchedulingVoid(value: unknown, operation: string): void {
    if (value !== undefined) throw new Error(`Scheduling ${operation} must resolve to undefined.`);
}

export function assertSchedulingSettlement(
    value: unknown,
): asserts value is SchedulingWaitSettlement {
    if (!Value.Check(schedulingWaitSettlementSchema, value)) {
        throw new Error("Scheduling host returned an invalid wait settlement.");
    }
    if (Value.Check(schedulingWaitResultSchema, value)) assertSchedulingWaitResult(value);
    else assertSchedulingWaitRecord(value);
}