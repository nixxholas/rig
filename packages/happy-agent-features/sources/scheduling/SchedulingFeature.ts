import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_SCHEDULING_CURSOR_LENGTH,
    MAX_SCHEDULING_DETAIL_PAGE_SIZE,
    MAX_SCHEDULING_FAILURE_LENGTH,
    MAX_SCHEDULING_FINGERPRINT_LENGTH,
    MAX_SCHEDULING_ID_LENGTH,
    MAX_SCHEDULING_MESSAGE_LENGTH,
    MAX_SCHEDULING_PAGE_SIZE,
    MAX_SCHEDULING_TIMESTAMP,
    schedulingAgentIdSchema,
    schedulingCancelInputSchema,
    schedulingCancelToolInputSchema,
    schedulingDeliveryOutcomeInputSchema,
    schedulingDurationSchema,
    schedulingElapsedRecordSchema,
    schedulingEventIdSchema,
    schedulingFingerprintSchema,
    schedulingInstantSchema,
    schedulingMessageIdSchema,
    schedulingOperationIdSchema,
    schedulingScheduleDetailPageSchema,
    schedulingScheduleDetailQuerySchema,
    schedulingScheduleInputSchema,
    schedulingSchedulePageQuerySchema,
    schedulingSchedulePageSchema,
    schedulingScheduleToolInputSchema,
    schedulingScheduleToolPageQuerySchema,
    schedulingScheduledMessageSchema,
    schedulingWaitInputSchema,
    schedulingWaitRecordSchema,
    schedulingWaitResultSchema,
    schedulingWaitSettlementSchema,
    schedulingWaitUntilInputSchema,
    schedulingWaitToolInputSchema,
    schedulingWaitUntilToolInputSchema,
    schedulingWaitingRecordSchema,
    type SchedulingCancelInput,
    type SchedulingDeliveryOutcomeInput,
    type SchedulingDuration,
    type SchedulingEventId,
    type SchedulingOperationId,
    type SchedulingScheduleDetailPage,
    type SchedulingScheduleDetailQuery,
    type SchedulingScheduleInput,
    type SchedulingSchedulePage,
    type SchedulingSchedulePageQuery,
    type SchedulingScheduledMessage,
    type SchedulingWaitInput,
    type SchedulingWaitRecord,
    type SchedulingWaitResult,
    type SchedulingWaitSettlement,
    type SchedulingWaitUntilInput,
} from "./Scheduling.js";
import {
    schedulingEventSchema,
    schedulingFeatureListenerSchema,
    type SchedulingEvent,
    type SchedulingFeatureListener,
} from "./SchedulingEvent.js";
import {
    assertSchedulingMutationProof,
    assertSchedulingMutationReceipt,
    assertSchedulingScheduledMessage,
    assertSchedulingScheduler,
    assertSchedulingSettlement,
    assertSchedulingStore,
    assertSchedulingTransactionChange,
    assertSchedulingWaitRecord,
    assertSchedulingWaitResult,
    assertSchedulingVoid,
    schedulingContextSchema,
    schedulingMutationKindSchema,
    schedulingMutationProofSchema,
    schedulingMutationReceiptSchema,
    schedulingMutationResultSchema,
    schedulingMutationRequestSchema,
    schedulingScheduleRequestSchema,
    schedulingSchedulerSchema,
    schedulingStoreSchema,
    schedulingTransactionChangeSchema,
    schedulingWaitClaimRequestSchema,
    type SchedulingMutationKind,
    type SchedulingMutationProof,
    type SchedulingMutationReceipt,
    type SchedulingMutationResult,
    type SchedulingScheduler,
    type SchedulingStore,
    type SchedulingTransactionChange,
} from "./SchedulingStore.js";
import { cancelScheduledMessageTool } from "./tools/cancel_scheduled_message.js";
import { listScheduledMessagesTool } from "./tools/list_scheduled_messages.js";
import { scheduleMessageTool } from "./tools/schedule_message.js";
import { waitTool } from "./tools/wait.js";
import { waitUntilTool } from "./tools/wait_until.js";

const MAX_CANONICAL_DEPTH = 8;
const MAX_CANONICAL_STRING_LENGTH = MAX_SCHEDULING_MESSAGE_LENGTH;
const MAX_CANONICAL_ARRAY_ITEMS = 512;
const MAX_CANONICAL_OBJECT_PROPERTIES = 512;
const DEFAULT_MAX_WAIT_DURATION = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SCHEDULE_HORIZON = 24 * 60 * 60 * 1_000;
const MAX_CONFIGURED_SCHEDULING_DURATION = 24 * 60 * 60 * 1_000;
// A host settlement is produced before the feature re-enters its receipt transaction. Allow
// bounded clock progress during that hand-off, while deriving the durable result from the later
// feature clock sample.
const MAX_SETTLEMENT_CLOCK_DRIFT = 60 * 1_000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 8_000;
const DEFAULT_MAX_MESSAGE_LENGTH = MAX_SCHEDULING_MESSAGE_LENGTH;

const operationStateSchema = Type.Object(
    {
        id: schedulingOperationIdSchema,
        fingerprint: Type.String({ maxLength: MAX_SCHEDULING_FINGERPRINT_LENGTH }),
    },
    { additionalProperties: false },
);

export const schedulingIdFactorySchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    Type.Union([schedulingOperationIdSchema, Type.Promise(schedulingOperationIdSchema)]),
);
export const schedulingEventIdFactorySchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    Type.Union([schedulingEventIdSchema, Type.Promise(schedulingEventIdSchema)]),
);
export const schedulingClockSchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    schedulingTimestampSchema(),
);

function schedulingTimestampSchema() {
    return Type.Integer({ minimum: 0, maximum: MAX_SCHEDULING_TIMESTAMP });
}

export const schedulingAuthorizationActionSchema = Type.Union([
    Type.Literal("read"),
    Type.Literal("list"),
    Type.Literal("schedule"),
    Type.Literal("cancel"),
    Type.Literal("delivery"),
]);
const authorizationFunctionSchema = Type.Function(
    [
        schedulingContextSchema,
        schedulingAgentIdSchema,
        schedulingAgentIdSchema,
        schedulingAuthorizationActionSchema,
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);
export const schedulingAuthorizationSchema = Type.Union([
    authorizationFunctionSchema,
    Type.Object(
        { authorize: authorizationFunctionSchema },
        { additionalProperties: false },
    ),
]);

const schedulePolicyFunctionSchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);
export const schedulingMessagePolicySchema = Type.Union([
    schedulePolicyFunctionSchema,
    Type.Object(
        { canSchedule: schedulePolicyFunctionSchema },
        { additionalProperties: false },
    ),
]);

const maxDurationSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_CONFIGURED_SCHEDULING_DURATION,
});
const maxPageSchema = Type.Integer({ minimum: 1, maximum: MAX_SCHEDULING_PAGE_SIZE });
const maxOutputSchema = Type.Integer({ minimum: 256, maximum: 100_000 });
const maxMessageSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_SCHEDULING_MESSAGE_LENGTH,
});
export const schedulingPostCommitErrorSchema = Type.Function(
    [schedulingContextSchema, schedulingEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export const schedulingFeatureOptionsSchema = Type.Object(
    {
        store: schedulingStoreSchema,
        scheduler: Type.Optional(schedulingSchedulerSchema),
        authorization: Type.Optional(schedulingAuthorizationSchema),
        scheduleMessagePolicy: Type.Optional(schedulingMessagePolicySchema),
        idFactory: Type.Optional(schedulingIdFactorySchema),
        eventIdFactory: Type.Optional(schedulingEventIdFactorySchema),
        clock: Type.Optional(schedulingClockSchema),
        listener: Type.Optional(schedulingFeatureListenerSchema),
        maxWaitDuration: Type.Optional(maxDurationSchema),
        maxScheduleHorizon: Type.Optional(maxDurationSchema),
        maxPageSize: Type.Optional(maxPageSchema),
        maxOutputCharacters: Type.Optional(maxOutputSchema),
        maxMessageLength: Type.Optional(maxMessageSchema),
        onPostCommitError: Type.Optional(schedulingPostCommitErrorSchema),
    },
    { additionalProperties: false },
);

export type SchedulingFeatureOptions = Static<typeof schedulingFeatureOptionsSchema>;
export type SchedulingAuthorizationAction = Static<typeof schedulingAuthorizationActionSchema>;
export type SchedulingAuthorization = Static<typeof schedulingAuthorizationSchema>;
export type SchedulingMessagePolicy = Static<typeof schedulingMessagePolicySchema>;

type SchedulingOperation = {
    readonly kind: SchedulingMutationKind;
    readonly actingAgentId: string;
    readonly operationId: string;
    readonly fingerprint: string;
};

export class SchedulingFeature implements AgentFeature {
    readonly name = "scheduling";

    readonly #store: SchedulingStore;
    readonly #scheduler: SchedulingScheduler;
    readonly #authorization: SchedulingAuthorization | undefined;
    readonly #scheduleMessagePolicy: SchedulingMessagePolicy | undefined;
    readonly #idFactory: NonNullable<SchedulingFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<SchedulingFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<SchedulingFeatureOptions["clock"]>;
    readonly #listener: SchedulingFeatureListener | undefined;
    readonly #onPostCommitError: SchedulingFeatureOptions["onPostCommitError"];
    readonly #maxWaitDuration: number;
    readonly #maxScheduleHorizon: number;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #maxMessageLength: number;

    constructor(options: SchedulingFeatureOptions) {
        const validated = validateOptions(options);
        this.#store = validated.store;
        this.#scheduler =
            validated.scheduler ??
            (() => {
                const owner = validated.store as unknown as Record<string, unknown>;
                const schedulerView = {
                    startWait:
                        typeof owner.startWait === "function"
                            ? owner.startWait.bind(validated.store)
                            : owner.startWait,
                    wait:
                        typeof owner.wait === "function"
                            ? owner.wait.bind(validated.store)
                            : owner.wait,
                    schedule:
                        typeof owner.schedule === "function"
                            ? owner.schedule.bind(validated.store)
                            : owner.schedule,
                    cancel:
                        typeof owner.cancel === "function"
                            ? owner.cancel.bind(validated.store)
                            : owner.cancel,
                    reportDelivery:
                        typeof owner.reportDelivery === "function"
                            ? owner.reportDelivery.bind(validated.store)
                            : owner.reportDelivery,
                };
                assertSchedulingScheduler(schedulerView);
                return schedulerView;
            })();
        this.#authorization = validated.authorization;
        this.#scheduleMessagePolicy = validated.scheduleMessagePolicy;
        this.#idFactory =
            validated.idFactory ??
            ((_ctx: Context, _agentId: string) =>
                `s${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 31)}`);
        this.#eventIdFactory =
            validated.eventIdFactory ??
            ((_ctx: Context, _agentId: string) =>
                `e${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 31)}`);
        this.#clock = validated.clock ?? ((_ctx: Context, _agentId: string) => Date.now());
        this.#listener = validated.listener;
        this.#onPostCommitError = validated.onPostCommitError;
        this.#maxWaitDuration = validated.maxWaitDuration ?? DEFAULT_MAX_WAIT_DURATION;
        this.#maxScheduleHorizon =
            validated.maxScheduleHorizon ?? DEFAULT_MAX_SCHEDULE_HORIZON;
        this.#maxPageSize = validated.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters =
            validated.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#maxMessageLength = validated.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    }

    readonly tools = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<readonly AnyAgentTool[]> => {
        this.#assertAgentId(scope.agent.id, "tool agent");
        const tools: AnyAgentTool[] = [
            waitTool(this, scope.agent.id),
            waitUntilTool(this, scope.agent.id),
            cancelScheduledMessageTool(this, scope.agent.id),
            listScheduledMessagesTool(this, scope.agent.id),
        ];
        if (await this.#maySchedule(ctx, scope.agent.id)) {
            tools.splice(2, 0, scheduleMessageTool(this, scope.agent.id));
        }
        return tools;
    };

    async wait(ctx: Context, agentId: string, input: SchedulingWaitInput): Promise<SchedulingWaitResult> {
        return await this.#wait(ctx, agentId, input, "wait");
    }

    async waitUntil(
        ctx: Context,
        agentId: string,
        input: SchedulingWaitUntilInput,
    ): Promise<SchedulingWaitResult> {
        return await this.#wait(ctx, agentId, input, "wait_until");
    }

    async schedule(
        ctx: Context,
        agentId: string,
        input: SchedulingScheduleInput,
    ): Promise<SchedulingScheduledMessage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingScheduleInputSchema, input, "schedule message");
        if (input.message.length > this.#maxMessageLength) {
            throw new Error(`Scheduled message exceeds ${this.#maxMessageLength} characters.`);
        }
        await this.#mayScheduleOrThrow(ctx, agentId);
        const targetAgentId = input.targetAgentId ?? agentId;
        this.#assertAgentId(targetAgentId, "target agent");
        await this.#authorize(ctx, agentId, targetAgentId, "schedule");
        if ("at" in input && !isIsoInstant(input.at)) {
            throw new Error("Scheduling time must be a valid ISO 8601 instant.");
        }
        const id = await this.#recordIdentity(
            ctx,
            agentId,
            "schedule.id",
            input.id,
            input.operationId,
        );
        const operationId = await this.#operationIdentity(
            ctx,
            agentId,
            "schedule",
            input.operationId,
        );
        const fingerprint = this.#fingerprint("schedule", agentId, {
            id,
            operationId,
            targetAgentId,
            message: input.message,
            timing: "in" in input ? { in: input.in } : { at: input.at },
        });
        await this.#bindOperationFingerprint(ctx, agentId, "schedule", fingerprint);
        await this.#bindRecordFingerprint(ctx, agentId, "schedule.id", fingerprint);
        const operation: SchedulingOperation = {
            kind: "schedule",
            actingAgentId: agentId,
            operationId,
            fingerprint,
        };
        const change = await this.#commit(ctx, agentId, operation, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replaySchedule(txCtx, agentId, operation, receipt, "schedule");
            }
            await this.#assertNoOrphanedProof(txCtx, agentId, operation);
            const existing = await this.#readSchedule(txCtx, agentId, id);
            if (existing !== undefined) {
                const dueAt = existing.dueAt;
                this.#assertScheduleRequest(
                    existing,
                    id,
                    agentId,
                    targetAgentId,
                    input.message,
                    dueAt,
                    operationId,
                    fingerprint,
                );
                const result = structuredClone(existing);
                const proof = this.#proof(
                    operation,
                    id,
                    existing,
                    existing,
                    result,
                    false,
                );
                await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
                return this.#change(operation, result, false, []);
            }
            // Measure a relative schedule after durable identity/store work so its delay and
            // the scheduler's creation timestamp share a consistent claim-time clock.
            const dueAt = this.#dueAtFromSchedule(this.#now(txCtx, agentId), input);
            const raw = await requirePromise(
                this.#scheduler.schedule(txCtx, agentId, {
                    id,
                    senderAgentId: agentId,
                    targetAgentId,
                    message: input.message,
                    dueAt,
                    operationId,
                    fingerprint,
                }),
                "Scheduling scheduler schedule",
            );
            assertSchedulingScheduledMessage(raw);
            this.#assertScheduleRequest(
                raw,
                id,
                agentId,
                targetAgentId,
                input.message,
                dueAt,
                operationId,
                fingerprint,
            );
            let persisted = await this.#readSchedule(txCtx, agentId, id);
            if (persisted === undefined) {
                await this.#writeSchedule(txCtx, raw);
                persisted = await this.#readRequiredSchedule(txCtx, agentId, id);
            }
            this.#assertScheduleRequest(
                persisted,
                id,
                agentId,
                targetAgentId,
                input.message,
                dueAt,
                operationId,
                fingerprint,
            );
            if (persisted.status !== "pending") {
                throw new Error("Scheduling scheduler returned a non-pending new message.");
            }
            const result = structuredClone(persisted);
            const proof = this.#proof(operation, id, undefined, result, result, true);
            const event = await this.#event(txCtx, {
                type: "message_scheduled",
                agentId,
                schedule: result,
            });
            await this.#announce(txCtx, event);
            await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
            return this.#change(operation, result, true, [event]);
        });
        this.#assertScheduleResult(change.result);
        return structuredClone(change.result);
    }

    async cancelSchedule(
        ctx: Context,
        agentId: string,
        input: SchedulingCancelInput | string,
        requestedOperationId?: string,
    ): Promise<SchedulingScheduledMessage> {
        this.#assertAgentId(agentId, "acting agent");
        const normalized: SchedulingCancelInput =
            typeof input === "string"
                ? {
                      scheduleId: input,
                      ...(requestedOperationId === undefined
                          ? {}
                          : { operationId: requestedOperationId }),
                  }
                : input;
        this.#assertInput(schedulingCancelInputSchema, normalized, "schedule cancellation");
        const operationId = await this.#operationIdentity(
            ctx,
            agentId,
            "cancel",
            normalized.operationId,
        );
        const fingerprint = this.#fingerprint("cancel", agentId, {
            scheduleId: normalized.scheduleId,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, agentId, "cancel", fingerprint);
        const operation: SchedulingOperation = {
            kind: "cancel",
            actingAgentId: agentId,
            operationId,
            fingerprint,
        };
        const change = await this.#commit(ctx, agentId, operation, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replaySchedule(txCtx, agentId, operation, receipt, "cancel");
            }
            await this.#assertNoOrphanedProof(txCtx, agentId, operation);
            const existing = await this.#readRequiredSchedule(
                txCtx,
                agentId,
                normalized.scheduleId,
            );
            await this.#authorize(txCtx, agentId, existing.senderAgentId, "cancel");
            if (existing.status !== "pending") {
                const result = structuredClone(existing);
                const proof = this.#proof(
                    operation,
                    existing.id,
                    existing,
                    existing,
                    result,
                    false,
                );
                await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
                return this.#change(operation, result, false, []);
            }
            const raw = await requirePromise(
                this.#scheduler.cancel(txCtx, agentId, {
                    ...normalized,
                    operationId,
                }),
                "Scheduling scheduler cancel",
            );
            assertSchedulingScheduledMessage(raw);
            let persisted = await this.#readSchedule(txCtx, agentId, existing.id);
            if (persisted === undefined) {
                await this.#writeSchedule(txCtx, raw);
                persisted = await this.#readRequiredSchedule(txCtx, agentId, existing.id);
            }
            this.#assertScheduleTransitionResult(raw, existing, persisted, "cancelled");
            const result = structuredClone(persisted);
            const changed = !sameJson(existing, persisted);
            const proof = this.#proof(
                operation,
                existing.id,
                existing,
                result,
                result,
                changed,
            );
            const event = await this.#event(txCtx, {
                type: "scheduled_message_cancelled",
                agentId,
                schedule: result,
            });
            await this.#announce(txCtx, event);
            await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
            return this.#change(operation, result, changed, [event]);
        });
        this.#assertScheduleResult(change.result);
        return structuredClone(change.result);
    }

    async listSchedulePage(
        ctx: Context,
        agentId: string,
        query: SchedulingSchedulePageQuery = {},
    ): Promise<SchedulingSchedulePage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingSchedulePageQuerySchema, query, "schedule page query");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Schedule page limit cannot exceed ${this.#maxPageSize}.`);
        }
        const senderAgentId = query.senderAgentId ?? agentId;
        await this.#authorize(ctx, agentId, senderAgentId, "list");
        const normalized = {
            ...query,
            limit,
            senderAgentId,
        };
        const raw = await requirePromise(
            this.#store.listSchedules(ctx, agentId, normalized),
            "Scheduling store listSchedules",
        );
        if (!Value.Check(schedulingSchedulePageSchema, raw)) {
            throw new Error("Scheduling store returned an invalid schedule page.");
        }
        const page = raw as SchedulingSchedulePage;
        this.#assertPage(page, query.cursor, limit);
        for (const schedule of page.schedules) {
            assertSchedulingScheduledMessage(schedule);
            this.#assertScheduleHorizon(schedule);
            if (schedule.senderAgentId !== senderAgentId) {
                throw new Error("Scheduling page returned a message outside the sender filter.");
            }
            if (
                query.targetAgentId !== undefined &&
                schedule.targetAgentId !== query.targetAgentId
            ) {
                throw new Error("Scheduling page returned a message outside the target filter.");
            }
            if (query.status !== undefined && schedule.status !== query.status) {
                throw new Error("Scheduling page returned a message outside the status filter.");
            }
            if (schedule.message.length > this.#maxMessageLength) {
                throw new Error("Scheduling store returned an oversized message.");
            }
        }
        return structuredClone(this.#fitSchedulePage(page, query.cursor));
    }

    async listSchedule(
        ctx: Context,
        agentId: string,
        query: SchedulingSchedulePageQuery = {},
    ): Promise<readonly SchedulingScheduledMessage[]> {
        return (await this.listSchedulePage(ctx, agentId, query)).schedules;
    }

    async getSchedule(
        ctx: Context,
        agentId: string,
        scheduleId: string,
    ): Promise<SchedulingScheduledMessage | undefined> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertId(scheduleId, "schedule");
        const schedule = await this.#readSchedule(ctx, agentId, scheduleId);
        if (schedule === undefined) return undefined;
        await this.#authorize(ctx, agentId, schedule.senderAgentId, "read");
        return structuredClone(schedule);
    }

    async getSchedulePage(
        ctx: Context,
        agentId: string,
        scheduleId: string,
        query: SchedulingScheduleDetailQuery = {},
    ): Promise<SchedulingScheduleDetailPage> {
        this.#assertInput(
            schedulingScheduleDetailQuerySchema,
            query,
            "schedule detail query",
        );
        const schedule = await this.getSchedule(ctx, agentId, scheduleId);
        if (schedule === undefined) {
            return { schedule: null, detail: "", detailOffset: 0, detailTotal: 0 };
        }
        const detail = scheduleDetailText(schedule);
        const offset = query.detailOffset ?? 0;
        const limit = query.detailLimit ?? MAX_SCHEDULING_DETAIL_PAGE_SIZE;
        if (offset > detail.length) {
            throw new Error("Schedule detail offset exceeds the available detail.");
        }
        const page: SchedulingScheduleDetailPage = {
            schedule,
            detail: detail.slice(offset, offset + limit),
            detailOffset: offset,
            detailTotal: detail.length,
            ...(offset + limit < detail.length
                ? { nextDetailOffset: offset + limit }
                : {}),
        };
        return this.#fitDetailPage(page);
    }

    async reportDeliveryOutcome(
        ctx: Context,
        agentId: string,
        input: SchedulingDeliveryOutcomeInput,
    ): Promise<SchedulingScheduledMessage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(
            schedulingDeliveryOutcomeInputSchema,
            input,
            "delivery outcome",
        );
        const operationId = await this.#operationIdentity(
            ctx,
            agentId,
            "delivery",
            input.operationId,
        );
        const fingerprint = this.#fingerprint(
            "delivery",
            agentId,
            input.status === "delivered"
                ? {
                      scheduleId: input.scheduleId,
                      operationId,
                      status: input.status,
                      deliveredAt: input.deliveredAt,
                  }
                : {
                      scheduleId: input.scheduleId,
                      operationId,
                      status: input.status,
                      failure: input.failure,
                  },
        );
        await this.#bindOperationFingerprint(ctx, agentId, "delivery", fingerprint);
        const operation: SchedulingOperation = {
            kind: "delivery",
            actingAgentId: agentId,
            operationId,
            fingerprint,
        };
        const change = await this.#commit(ctx, agentId, operation, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replaySchedule(txCtx, agentId, operation, receipt, "delivery");
            }
            await this.#assertNoOrphanedProof(txCtx, agentId, operation);
            const before = await this.#readRequiredSchedule(txCtx, agentId, input.scheduleId);
            await this.#authorize(txCtx, agentId, before.senderAgentId, "delivery");
            if (before.status !== "pending") {
                const result = structuredClone(before);
                const proof = this.#proof(
                    operation,
                    before.id,
                    before,
                    before,
                    result,
                    false,
                );
                await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
                return this.#change(operation, result, false, []);
            }
            const deliveryRequest =
                input.status === "delivered"
                    ? {
                          scheduleId: input.scheduleId,
                          status: input.status,
                          operationId,
                          fingerprint,
                          ...(input.deliveredAt === undefined
                              ? {}
                              : { deliveredAt: input.deliveredAt }),
                      }
                    : {
                          scheduleId: input.scheduleId,
                          status: input.status,
                          operationId,
                          fingerprint,
                          failure: input.failure,
                      };
            const raw = await requirePromise(
                this.#scheduler.reportDelivery(txCtx, agentId, deliveryRequest),
                "Scheduling scheduler reportDelivery",
            );
            assertSchedulingScheduledMessage(raw);
            let after = await this.#readSchedule(txCtx, agentId, before.id);
            if (after === undefined) {
                await this.#writeSchedule(txCtx, raw);
                after = await this.#readRequiredSchedule(txCtx, agentId, before.id);
            }
            this.#assertScheduleTransitionResult(raw, before, after, input.status, input);
            const result = structuredClone(after);
            const changed = !sameJson(before, after);
            const proof = this.#proof(operation, before.id, before, after, result, changed);
            const event = await this.#event(txCtx, {
                type: "scheduled_message_delivery_outcome",
                agentId,
                schedule: result,
            });
            await this.#announce(txCtx, event);
            await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
            return this.#change(operation, result, changed, [event]);
        });
        this.#assertScheduleResult(change.result);
        return structuredClone(change.result);
    }

    formatWaitForModel(result: SchedulingWaitResult): string {
        assertSchedulingWaitResult(result);
        const elapsed = humanDuration(result.elapsedMs);
        return result.outcome === "interrupted"
            ? `Wait ${result.waitId} was interrupted; ${elapsed} actually elapsed.`
            : `Wait ${result.waitId} elapsed after ${elapsed}.`;
    }

    formatForModel(
        result:
            | SchedulingWaitResult
            | SchedulingScheduledMessage
            | SchedulingSchedulePage
            | SchedulingScheduleDetailPage,
    ): string {
        if (Value.Check(schedulingWaitResultSchema, result)) {
            return this.formatWaitForModel(result);
        }
        if (Value.Check(schedulingSchedulePageSchema, result)) {
            return this.formatSchedulePageForModel(result);
        }
        if (Value.Check(schedulingScheduleDetailPageSchema, result)) {
            return this.formatScheduleDetailPageForModel(result);
        }
        return this.formatScheduleForModel(result as SchedulingScheduledMessage);
    }

    formatScheduleForModel(schedule: SchedulingScheduledMessage): string {
        assertSchedulingScheduledMessage(schedule);
        const compact = `Scheduled message ${schedule.id} is ${scheduleStatusLabel(
            schedule.status,
        )}; due ${new Date(
            schedule.dueAt,
        ).toISOString()}.`;
        if (compact.length <= this.#maxOutputCharacters) return compact;
        // The ID is the actionable identity. Keep it complete at the minimum output budget, and
        // leave optional routing prose to a host detail page.
        const minimum = `${schedule.id} | ${scheduleStatusLabel(schedule.status)}`;
        if (minimum.length <= this.#maxOutputCharacters) return minimum;
        throw new Error("Scheduled message identity cannot fit the model-output bound.");
    }

    formatCancellationForModel(schedule: SchedulingScheduledMessage): string {
        assertSchedulingScheduledMessage(schedule);
        return `Scheduled message ${schedule.id} is now ${scheduleStatusLabel(schedule.status)}.`;
    }

    formatSchedulePageForModel(page: SchedulingSchedulePage): string {
        if (!Value.Check(schedulingSchedulePageSchema, page)) {
            throw new Error("Cannot format an invalid schedule page.");
        }
        const visible = this.#fitSchedulePage(
            page,
            String(inferSchedulePageStart(page)),
        );
        const continuation = [
            visible.previousCursor === undefined
                ? ""
                : `Earlier scheduled messages start at cursor ${visible.previousCursor}.`,
            visible.nextCursor === undefined
                ? ""
                : `More scheduled messages start at cursor ${visible.nextCursor}.`,
        ]
            .filter((line) => line.length > 0)
            .join("\n");
        const output = visible.schedules.length === 0
            ? `No scheduled messages.${continuation === "" ? "" : `\n${continuation}`}`
            : this.#schedulePageText(visible);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Schedule page exceeds the model-output bound.");
        }
        return output;
    }

    formatScheduleDetailPageForModel(
        page: SchedulingScheduleDetailPage | SchedulingScheduledMessage,
    ): string {
        const detailPage = Value.Check(schedulingScheduleDetailPageSchema, page)
            ? page
            : Value.Check(schedulingScheduledMessageSchema, page)
              ? this.#fitDetailPage({
                    schedule: page,
                    detail: scheduleDetailText(page),
                    detailOffset: 0,
                    detailTotal: scheduleDetailText(page).length,
                })
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format an invalid schedule detail page.");
        }
        if (detailPage.schedule === null) return "That scheduled message does not exist.";
        const prefix = `${detailPage.schedule.id} | ${scheduleStatusLabel(
            detailPage.schedule.status,
        )}`;
        const continuation =
            detailPage.nextDetailOffset === undefined
                ? ""
                : `\nMore detail starts at offset ${detailPage.nextDetailOffset}.`;
        const output = `${prefix}\n${detailPage.detail}${continuation}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Schedule detail exceeds the model-output bound.");
        }
        return output;
    }

    #now(ctx: Context, agentId: string): number {
        const raw = this.#clock(ctx, agentId);
        this.#assertTimestamp(raw, "clock value");
        return raw;
    }

    async #wait(
        ctx: Context,
        agentId: string,
        input: SchedulingWaitInput | SchedulingWaitUntilInput,
        kind: "wait" | "wait_until",
    ): Promise<SchedulingWaitResult> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(
            kind === "wait" ? schedulingWaitInputSchema : schedulingWaitUntilInputSchema,
            input,
            `${kind} input`,
        );
        const id = await this.#recordIdentity(
            ctx,
            agentId,
            `wait.${kind}.id`,
            input.id,
            input.operationId,
        );
        const operationId = await this.#operationIdentity(
            ctx,
            agentId,
            `wait.${kind}`,
            input.operationId,
        );
        if ("at" in input && !isIsoInstant(input.at)) {
            throw new Error("Scheduling time must be a valid ISO 8601 instant.");
        }
        const fingerprint = this.#fingerprint(kind, agentId, {
            id,
            operationId,
            request:
                "duration" in input
                    ? { duration: input.duration }
                    : { at: input.at },
        });
        await this.#bindOperationFingerprint(ctx, agentId, `wait.${kind}`, fingerprint);
        await this.#bindRecordFingerprint(ctx, agentId, `wait.${kind}.id`, fingerprint);
        const operation: SchedulingOperation = {
            kind: "wait",
            actingAgentId: agentId,
            operationId,
            fingerprint,
        };
        let dueAt: number | undefined;
        let startedAt: number | undefined;

        const claimed = await this.#commit(ctx, agentId, operation, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayWait(txCtx, agentId, operation, receipt, id);
            }
            await this.#assertNoOrphanedProof(txCtx, agentId, operation);
            const existing = await this.#readWait(txCtx, agentId, id);
            if (existing !== undefined) {
                dueAt = existing.dueAt;
                startedAt = existing.startedAt;
                this.#assertWaitRequest(
                    existing,
                    agentId,
                    id,
                    operation,
                    kind,
                    dueAt,
                    startedAt,
                );
                if (existing.status !== "waiting") {
                    const result = resultFromWait(existing);
                    const proof = this.#proof(
                        operation,
                        id,
                        existing,
                        existing,
                        result,
                        false,
                    );
                    await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
                    return this.#change(operation, result, false, []);
                }
                return this.#change(operation, existing, false, []);
            }
            // Claim time is the one instant from which both the durable start and a relative due
            // time are derived. This prevents identity/store latency from shortening a wait.
            startedAt = this.#now(txCtx, agentId);
            dueAt =
                "duration" in input
                    ? this.#dueAtFromDuration(startedAt, input.duration)
                    : this.#dueAtFromInstant(startedAt, input.at);
            if (startedAt > dueAt) {
                throw new Error("Scheduling wait due time is already in the past.");
            }
            const claimRequest = {
                id,
                agentId,
                operationId,
                fingerprint,
                kind,
                dueAt,
                startedAt,
            };
            const raw = await requirePromise(
                this.#scheduler.startWait(txCtx, agentId, claimRequest),
                "Scheduling scheduler startWait",
            );
            assertSchedulingWaitRecord(raw);
            this.#assertWaitRequest(
                raw,
                agentId,
                id,
                operation,
                kind,
                dueAt,
                startedAt,
            );
            let persisted = await this.#readWait(txCtx, agentId, id);
            if (persisted === undefined) {
                await this.#writeWait(txCtx, raw);
                persisted = await this.#readRequiredWait(txCtx, agentId, id);
            }
            this.#assertWaitRequest(
                persisted,
                agentId,
                id,
                operation,
                kind,
                dueAt,
                startedAt,
            );
            if (persisted.status !== "waiting") {
                throw new Error("Scheduling scheduler returned a terminal wait while claiming.");
            }
            const event = await this.#event(txCtx, {
                type: "wait_started",
                agentId,
                wait: persisted,
            });
            await this.#announce(txCtx, event);
            return this.#change(operation, persisted, true, [event]);
        });

        if (Value.Check(schedulingWaitResultSchema, claimed.result)) {
            assertSchedulingWaitResult(claimed.result);
            return structuredClone(claimed.result);
        }
        assertSchedulingWaitRecord(claimed.result);
        if (claimed.result.status !== "waiting") {
            return structuredClone(resultFromWait(claimed.result));
        }
        if (dueAt === undefined || startedAt === undefined) {
            throw new Error("Scheduling wait claim did not retain its durable timing.");
        }
        const claimedDueAt = dueAt;
        const claimedStartedAt = startedAt;

        // This is intentionally outside every store transaction. The host owns the durable wait,
        // including interruption by a new chat message and restart recovery.
        const settlementRaw = await requirePromise(
            this.#scheduler.wait(ctx, agentId, id),
            "Scheduling scheduler wait",
        );
        assertSchedulingSettlement(settlementRaw);

        const finished = await this.#commit(ctx, agentId, operation, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayWait(txCtx, agentId, operation, receipt, id);
            }
            await this.#assertNoOrphanedProof(txCtx, agentId, operation);
            const before = await this.#readRequiredWait(txCtx, agentId, id);
            this.#assertWaitRequest(
                before,
                agentId,
                id,
                operation,
                kind,
                claimedDueAt,
                claimedStartedAt,
            );
            if (before.status === "waiting") {
                const finishedAt = this.#now(txCtx, agentId);
                const terminal = terminalWaitFromSettlement(
                    before,
                    settlementRaw,
                    finishedAt,
                );
                await this.#writeWait(txCtx, terminal);
            }
            const after = await this.#readRequiredWait(txCtx, agentId, id);
            if (after.status === "waiting") {
                throw new Error("Scheduling wait completed without a terminal durable record.");
            }
            const result = resultFromWait(after);
            const proof = this.#proof(
                operation,
                id,
                before,
                after,
                result,
                before.status === "waiting",
            );
            if (before.status === "waiting") {
                const event = await this.#event(txCtx, {
                    type: "wait_finished",
                    agentId,
                    wait: after,
                    result,
                });
                await this.#announce(txCtx, event);
                await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
                return this.#change(operation, result, true, [event]);
            }
            await this.#persistProofAndReceipt(txCtx, agentId, operation, proof, result);
            return this.#change(operation, result, false, []);
        });
        if (!Value.Check(schedulingWaitResultSchema, finished.result)) {
            throw new Error("Scheduling wait returned a non-result terminal value.");
        }
        assertSchedulingWaitResult(finished.result);
        return structuredClone(finished.result);
    }

    #dueAtFromSchedule(now: number, input: SchedulingScheduleInput): number {
        const dueAt = "in" in input
            ? this.#dueAtFromDuration(now, input.in, this.#maxScheduleHorizon)
            : this.#dueAtFromInstant(now, input.at, this.#maxScheduleHorizon);
        return dueAt;
    }

    #dueAtFromDuration(
        now: number,
        duration: SchedulingDuration,
        horizon = this.#maxWaitDuration,
    ): number {
        if (!Value.Check(schedulingDurationSchema, duration)) {
            throw new Error("Scheduling duration is invalid.");
        }
        const multipliers: Record<"seconds" | "minutes" | "hours" | "days", number> = {
            seconds: 1_000,
            minutes: 60_000,
            hours: 3_600_000,
            days: 86_400_000,
        };
        const normalized: {
            unit: keyof typeof multipliers;
            value: number;
        } =
            "unit" in duration
                ? {
                      unit:
                          duration.unit === "second" || duration.unit === "seconds"
                              ? "seconds"
                              : duration.unit === "minute" || duration.unit === "minutes"
                                ? "minutes"
                                : duration.unit === "hour" || duration.unit === "hours"
                                  ? "hours"
                                  : "days",
                      value: duration.value,
                  }
                : "seconds" in duration
                  ? { unit: "seconds" as const, value: duration.seconds }
                  : "minutes" in duration
                    ? { unit: "minutes" as const, value: duration.minutes }
                      : "hours" in duration
                        ? { unit: "hours" as const, value: duration.hours }
                        : { unit: "days" as const, value: duration.days };
        if (!Number.isFinite(normalized.value) || normalized.value < 0) {
            throw new Error("Scheduling duration is not a finite non-negative amount.");
        }
        const amount = normalized.value * multipliers[normalized.unit];
        if (!Number.isSafeInteger(amount) || amount < 0) {
            throw new Error(
                "Scheduling duration must resolve to a finite whole number of milliseconds.",
            );
        }
        if (amount > horizon) {
            throw new Error(
                `Scheduling duration cannot exceed ${humanDuration(horizon)}.`,
            );
        }
        const dueAt = now + amount;
        this.#assertTimestamp(dueAt, "due time");
        return dueAt;
    }

    #dueAtFromInstant(now: number, instant: string, horizon = this.#maxWaitDuration): number {
        if (!Value.Check(schedulingInstantSchema, instant) || !isIsoInstant(instant)) {
            throw new Error("Scheduling time must be a valid ISO 8601 instant.");
        }
        const dueAt = Date.parse(instant);
        this.#assertTimestamp(dueAt, "scheduled time");
        if (dueAt < now) throw new Error("Scheduling time is in the past.");
        if (dueAt - now > horizon) {
            throw new Error(`Scheduling time cannot be more than ${humanDuration(horizon)} away.`);
        }
        return dueAt;
    }

    async #maySchedule(ctx: Context, agentId: string): Promise<boolean> {
        if (this.#scheduleMessagePolicy === undefined) return true;
        const policy =
            typeof this.#scheduleMessagePolicy === "function"
                ? this.#scheduleMessagePolicy
                : this.#scheduleMessagePolicy.canSchedule;
        const raw = policy.call(
            typeof this.#scheduleMessagePolicy === "function"
                ? undefined
                : this.#scheduleMessagePolicy,
            ctx,
            agentId,
        );
        const result = raw instanceof Promise ? await raw : raw;
        if (typeof result !== "boolean") {
            throw new Error("Scheduling message policy returned a non-boolean result.");
        }
        return result;
    }

    async #mayScheduleOrThrow(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.#maySchedule(ctx, agentId))) {
            throw new Error(`Agent "${agentId}" is not allowed to schedule messages.`);
        }
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
        action: SchedulingAuthorizationAction,
    ): Promise<void> {
        if (actingAgentId === targetAgentId) return;
        if (this.#authorization === undefined) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} scheduling data for "${targetAgentId}".`,
            );
        }
        const policy =
            typeof this.#authorization === "function"
                ? this.#authorization
                : this.#authorization.authorize;
        const raw = policy.call(
            typeof this.#authorization === "function" ? undefined : this.#authorization,
            ctx,
            actingAgentId,
            targetAgentId,
            action,
        );
        const allowed = raw instanceof Promise ? await raw : raw;
        if (typeof allowed !== "boolean" || !allowed) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} scheduling data for "${targetAgentId}".`,
            );
        }
    }

    async #commit(
        ctx: Context,
        agentId: string,
        operation: SchedulingOperation,
        decide: (txCtx: Context) => Promise<SchedulingTransactionChange>,
    ): Promise<SchedulingTransactionChange> {
        let expected: SchedulingTransactionChange | undefined;
        const raw = this.#store.transaction(ctx, agentId, async (txCtx) => {
            const change = await decide(txCtx);
            assertSchedulingTransactionChange(change);
            if (
                change.kind !== operation.kind ||
                change.operationId !== operation.operationId ||
                change.actingAgentId !== agentId
            ) {
                throw new Error("Scheduling transaction returned a different operation identity.");
            }
            expected = deepFreeze(structuredClone(change));
            return structuredClone(expected);
        });
        const returned = await requirePromise(raw, "Scheduling store transaction");
        assertSchedulingTransactionChange(returned);
        if (expected === undefined || !sameJson(returned, expected)) {
            throw new Error("Scheduling store transaction returned a substituted change.");
        }
        return structuredClone(returned);
    }

    #change(
        operation: SchedulingOperation,
        result: SchedulingMutationResult,
        changed: boolean,
        events: readonly SchedulingEvent[],
    ): SchedulingTransactionChange {
        const change = {
            kind: operation.kind,
            operationId: operation.operationId,
            actingAgentId: operation.actingAgentId,
            result: structuredClone(result),
            changed,
            events: events.map((event) => cloneAndFreezeEvent(event)),
        };
        assertSchedulingTransactionChange(change);
        return change;
    }

    async #event(
        ctx: Context,
        payload:
            | { readonly type: "wait_started"; readonly agentId: string; readonly wait: SchedulingWaitRecord }
            | {
                  readonly type: "wait_finished";
                  readonly agentId: string;
                  readonly wait: SchedulingWaitRecord;
                  readonly result: SchedulingWaitResult;
              }
            | {
                  readonly type:
                      | "message_scheduled"
                      | "scheduled_message_cancelled"
                      | "scheduled_message_delivery_outcome";
                  readonly agentId: string;
                  readonly schedule: SchedulingScheduledMessage;
              },
    ): Promise<SchedulingEvent> {
        const eventIdRaw = this.#eventIdFactory(ctx, payload.agentId);
        const eventId = eventIdRaw instanceof Promise ? await eventIdRaw : eventIdRaw;
        if (!Value.Check(schedulingEventIdSchema, eventId)) {
            throw new Error("Scheduling event identity factory returned an invalid ID.");
        }
        const at = this.#now(ctx, payload.agentId);
        const event = { ...payload, eventId, at };
        if (!Value.Check(schedulingEventSchema, event)) {
            throw new Error("Scheduling feature created an invalid event.");
        }
        return cloneAndFreezeEvent(event as SchedulingEvent);
    }

    async #announce(ctx: Context, event: SchedulingEvent): Promise<void> {
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            const result = await transactional.call(this.#listener, ctx, event);
            assertSchedulingVoid(result, "transactional listener");
        }
        const registration = this.#store.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, event),
        );
        if (registration !== undefined) {
            throw new Error("Scheduling store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: SchedulingEvent): Promise<void> {
        try {
            const listener = this.#listener?.onEvent;
            if (listener !== undefined) {
                const result = await listener.call(this.#listener, ctx, event);
                assertSchedulingVoid(result, "post-commit listener");
            }
        } catch (error: unknown) {
            try {
                const handler = this.#onPostCommitError;
                if (handler !== undefined) {
                    const result = handler(ctx, event, safeError(error));
                    assertSchedulingVoid(
                        result instanceof Promise ? await result : result,
                        "post-commit error handler",
                    );
                }
            } catch {
                // Post-commit observation is advisory and cannot undo durable state.
            }
        }
    }

    async #readWait(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord | undefined> {
        const raw = await requirePromise(
            this.#store.readWait(ctx, agentId, id),
            "Scheduling store readWait",
        );
        if (raw === undefined) return undefined;
        assertSchedulingWaitRecord(raw);
        if (raw.id !== id || raw.agentId !== agentId) {
            throw new Error("Scheduling store returned a different durable wait identity.");
        }
        return structuredClone(raw);
    }

    async #readRequiredWait(ctx: Context, agentId: string, id: string): Promise<SchedulingWaitRecord> {
        const wait = await this.#readWait(ctx, agentId, id);
        if (wait === undefined) throw new Error(`Scheduling wait "${id}" does not exist.`);
        return wait;
    }

    async #writeWait(ctx: Context, wait: SchedulingWaitRecord): Promise<void> {
        assertSchedulingWaitRecord(wait);
        const expected = structuredClone(wait);
        const raw = await requirePromise(
            this.#store.writeWait(ctx, structuredClone(expected)),
            "Scheduling store writeWait",
        );
        assertSchedulingVoid(raw, "store writeWait");
        const persisted = await this.#readRequiredWait(ctx, expected.agentId, expected.id);
        if (!sameJson(persisted, expected)) {
            throw new Error("Scheduling store substituted the durable wait.");
        }
    }

    async #readSchedule(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingScheduledMessage | undefined> {
        const raw = await requirePromise(
            this.#store.readSchedule(ctx, agentId, id),
            "Scheduling store readSchedule",
        );
        if (raw === undefined) return undefined;
        assertSchedulingScheduledMessage(raw);
        if (raw.id !== id) {
            throw new Error("Scheduling store returned a different scheduled message identity.");
        }
        if (raw.message.length > this.#maxMessageLength) {
            throw new Error("Scheduling store returned an oversized message.");
        }
        this.#assertScheduleHorizon(raw);
        return structuredClone(raw);
    }

    async #readRequiredSchedule(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingScheduledMessage> {
        const schedule = await this.#readSchedule(ctx, agentId, id);
        if (schedule === undefined) {
            throw new Error(`Scheduled message "${id}" does not exist.`);
        }
        return schedule;
    }

    async #writeSchedule(
        ctx: Context,
        schedule: SchedulingScheduledMessage,
    ): Promise<void> {
        assertSchedulingScheduledMessage(schedule);
        const expected = structuredClone(schedule);
        const raw = await requirePromise(
            this.#store.writeSchedule(ctx, structuredClone(expected)),
            "Scheduling store writeSchedule",
        );
        assertSchedulingVoid(raw, "store writeSchedule");
        const persisted = await this.#readRequiredSchedule(
            ctx,
            expected.senderAgentId,
            expected.id,
        );
        if (!sameJson(persisted, expected)) {
            throw new Error("Scheduling store substituted the scheduled message.");
        }
    }

    async #readReceipt(
        ctx: Context,
        agentId: string,
        operation: SchedulingOperation,
    ): Promise<SchedulingMutationReceipt | undefined> {
        const raw = await requirePromise(
            this.#store.readReceipt(ctx, agentId, operation.operationId),
            "Scheduling store readReceipt",
        );
        if (raw === undefined) return undefined;
        assertSchedulingMutationReceipt(raw);
        if (
            raw.kind !== operation.kind ||
            raw.operationId !== operation.operationId ||
            raw.actingAgentId !== agentId ||
            raw.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Scheduling operation identity was reused with different input.");
        }
        if (raw.kind === "wait") {
            assertSchedulingWaitResult(raw.result);
        } else {
            assertSchedulingScheduledMessage(raw.result);
        }
        return structuredClone(raw);
    }

    async #assertNoOrphanedProof(
        ctx: Context,
        agentId: string,
        operation: SchedulingOperation,
    ): Promise<void> {
        const raw = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, operation.operationId),
            "Scheduling store readMutationProof",
        );
        if (raw === undefined) return;
        assertSchedulingMutationProof(raw);
        if (
            raw.kind !== operation.kind ||
            raw.operationId !== operation.operationId ||
            raw.actingAgentId !== agentId ||
            raw.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Scheduling operation identity was reused with different input.");
        }
        throw new Error("Scheduling found an immutable proof without its replay receipt.");
    }

    async #persistProofAndReceipt(
        ctx: Context,
        agentId: string,
        operation: SchedulingOperation,
        proof: SchedulingMutationProof,
        result: SchedulingWaitResult | SchedulingScheduledMessage,
    ): Promise<void> {
        assertSchedulingMutationProof(proof);
        assertSchedulingMutationReceipt({
            kind: operation.kind,
            operationId: operation.operationId,
            actingAgentId: agentId,
            fingerprint: operation.fingerprint,
            result,
        });
        const proofRaw = await requirePromise(
            this.#store.writeMutationProof(ctx, structuredClone(proof)),
            "Scheduling store writeMutationProof",
        );
        assertSchedulingVoid(proofRaw, "store writeMutationProof");
        const persistedProof = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, operation.operationId),
            "Scheduling store readMutationProof",
        );
        assertSchedulingMutationProof(persistedProof);
        if (!sameJson(persistedProof, proof)) {
            throw new Error("Scheduling store substituted the immutable mutation proof.");
        }
        const receipt = {
            kind: operation.kind,
            operationId: operation.operationId,
            actingAgentId: agentId,
            fingerprint: operation.fingerprint,
            result: structuredClone(result),
        } as SchedulingMutationReceipt;
        const receiptRaw = await requirePromise(
            this.#store.writeReceipt(ctx, structuredClone(receipt)),
            "Scheduling store writeReceipt",
        );
        assertSchedulingVoid(receiptRaw, "store writeReceipt");
        const persistedReceipt = await this.#readReceipt(ctx, agentId, operation);
        if (persistedReceipt === undefined || !sameJson(persistedReceipt, receipt)) {
            throw new Error("Scheduling store substituted the mutation receipt.");
        }
    }

    async #replaySchedule(
        ctx: Context,
        agentId: string,
        operation: SchedulingOperation,
        receipt: SchedulingMutationReceipt,
        kind: "schedule" | "cancel" | "delivery",
    ): Promise<SchedulingTransactionChange> {
        if (!Value.Check(schedulingScheduledMessageSchema, receipt.result)) {
            throw new Error("Scheduling receipt has a non-schedule result.");
        }
        assertSchedulingScheduledMessage(receipt.result);
        const proof = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, operation.operationId),
            "Scheduling store readMutationProof",
        );
        if (proof === undefined) {
            throw new Error("Scheduling receipt has no immutable proof.");
        }
        assertSchedulingMutationProof(proof);
        assertProofTransition(proof);
        if (
            proof.kind !== kind ||
            proof.actingAgentId !== agentId ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint ||
            proof.subjectId !== receipt.result.id ||
            !sameJson(proof.result, receipt.result) ||
            !sameJson(proof.after, receipt.result)
        ) {
            throw new Error("Scheduling receipt and immutable proof disagree.");
        }
        const current = await this.#readRequiredSchedule(
            ctx,
            agentId,
            receipt.result.id,
        );
        if (
            current.senderAgentId !== receipt.result.senderAgentId ||
            current.targetAgentId !== receipt.result.targetAgentId ||
            current.message !== receipt.result.message ||
            current.dueAt !== receipt.result.dueAt ||
            current.createdAt !== receipt.result.createdAt ||
            current.operationId !== receipt.result.operationId ||
            current.fingerprint !== receipt.result.fingerprint
        ) {
            throw new Error("Scheduling receipt disagrees with the authoritative message.");
        }
        if (
            (kind === "cancel" || kind === "delivery") &&
            current.status === "pending"
        ) {
            throw new Error("Scheduling receipt disagrees with the authoritative message status.");
        }
        return this.#change(
            operation,
            kind === "cancel" || kind === "delivery"
                ? structuredClone(receipt.result)
                : structuredClone(current),
            false,
            [],
        );
    }

    async #replayWait(
        ctx: Context,
        agentId: string,
        operation: SchedulingOperation,
        receipt: SchedulingMutationReceipt,
        waitId: string,
    ): Promise<SchedulingTransactionChange> {
        if (!Value.Check(schedulingWaitResultSchema, receipt.result)) {
            throw new Error("Scheduling wait receipt has a non-wait result.");
        }
        assertSchedulingWaitResult(receipt.result);
        const proof = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, operation.operationId),
            "Scheduling store readMutationProof",
        );
        if (proof === undefined) throw new Error("Scheduling wait receipt has no immutable proof.");
        assertSchedulingMutationProof(proof);
        assertProofTransition(proof);
        if (
            proof.kind !== "wait" ||
            proof.actingAgentId !== agentId ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint ||
            proof.subjectId !== waitId ||
            !sameJson(proof.result, receipt.result) ||
            proof.after === null ||
            !Value.Check(schedulingWaitRecordSchema, proof.after) ||
            !sameJson(resultFromWait(proof.after), receipt.result)
        ) {
            throw new Error("Scheduling wait receipt and immutable proof disagree.");
        }
        const current = await this.#readRequiredWait(ctx, agentId, waitId);
        if (
            current.agentId !== agentId ||
            current.operationId !== operation.operationId ||
            current.fingerprint !== operation.fingerprint ||
            current.kind !== receipt.result.kind ||
            current.dueAt !== receipt.result.dueAt ||
            current.status === "waiting" ||
            !sameJson(resultFromWait(current), receipt.result)
        ) {
            throw new Error("Scheduling wait receipt disagrees with the durable wait.");
        }
        return this.#change(operation, structuredClone(receipt.result), false, []);
    }

    #proof(
        operation: SchedulingOperation,
        subjectId: string,
        before: SchedulingWaitRecord | SchedulingScheduledMessage | undefined,
        after: SchedulingWaitRecord | SchedulingScheduledMessage,
        result: SchedulingWaitResult | SchedulingScheduledMessage,
        changed: boolean,
    ): SchedulingMutationProof {
        const proof = {
            kind: operation.kind,
            operationId: operation.operationId,
            actingAgentId: operation.actingAgentId,
            fingerprint: operation.fingerprint,
            subjectId,
            before: before === undefined ? null : structuredClone(before),
            after: structuredClone(after),
            changed,
            result: structuredClone(result),
        } as SchedulingMutationProof;
        assertSchedulingMutationProof(proof);
        assertProofTransition(proof);
        return deepFreeze(proof);
    }

    async #operationIdentity(
        ctx: Context,
        agentId: string,
        kind: string,
        requested: string | undefined,
    ): Promise<string> {
        if (requested === undefined && !isCallScopedAgentKV(agentKV(ctx))) {
            throw new Error(
                "A host-facing scheduling mutation must provide an operation identity.",
            );
        }
        return await this.#identity(ctx, agentId, `operation.${kind}`, requested);
    }

    async #recordIdentity(
        ctx: Context,
        agentId: string,
        key: string,
        requested: string | undefined,
        seed: string | undefined,
    ): Promise<string> {
        if (requested === undefined && !isCallScopedAgentKV(agentKV(ctx))) {
            if (seed === undefined) {
                throw new Error(
                    "A host-facing scheduling mutation must provide an operation identity.",
                );
            }
            if (!Value.Check(schedulingMessageIdSchema, seed)) {
                throw new Error("Scheduling record identity is invalid.");
            }
            return seed;
        }
        return await this.#identity(ctx, agentId, key, requested);
    }

    async #identity(
        ctx: Context,
        agentId: string,
        key: string,
        requested: string | undefined,
    ): Promise<string> {
        if (requested !== undefined && !Value.Check(schedulingOperationIdSchema, requested)) {
            throw new Error("Scheduling operation identity is invalid.");
        }
        const kv = agentKV(ctx);
        if (isCallScopedAgentKV(kv)) {
            const state = await kv.update(ctx, key, async (current) => {
                if (current !== undefined) {
                    if (!Value.Check(operationStateSchema, current)) {
                        throw new Error("Stored scheduling operation identity is invalid.");
                    }
                    if (requested !== undefined && current.id !== requested) {
                        throw new Error("The scheduling retry supplied a different identity.");
                    }
                    return current;
                }
                const generated = requested ?? (await this.#newIdentity(ctx, agentId));
                return { id: generated, fingerprint: "" };
            });
            if (!Value.Check(operationStateSchema, state)) {
                throw new Error("Stored scheduling operation identity is invalid.");
            }
            return state.id;
        }
        if (requested !== undefined) return requested;
        throw new Error(
            "A host-facing scheduling mutation must provide an operation identity.",
        );
    }

    async #bindOperationFingerprint(
        ctx: Context,
        _agentId: string,
        kind: string,
        fingerprint: string,
    ): Promise<void> {
        await this.#bindFingerprint(ctx, `operation.${kind}`, fingerprint);
    }

    async #bindRecordFingerprint(
        ctx: Context,
        _agentId: string,
        key: string,
        fingerprint: string,
    ): Promise<void> {
        await this.#bindFingerprint(ctx, key, fingerprint);
    }

    async #bindFingerprint(ctx: Context, key: string, fingerprint: string): Promise<void> {
        const kv = agentKV(ctx);
        if (!isCallScopedAgentKV(kv)) return;
        const state = await kv.read(ctx, key);
        if (!Value.Check(operationStateSchema, state)) {
            throw new Error("Stored scheduling identity is invalid.");
        }
        if (state.fingerprint !== "" && state.fingerprint !== fingerprint) {
            throw new Error("The scheduling durable identity was reused with different input.");
        }
        if (state.fingerprint === "") {
            await kv.write(ctx, key, { ...state, fingerprint });
        }
    }

    async #newIdentity(ctx: Context, agentId: string): Promise<string> {
        const raw = this.#idFactory(ctx, agentId);
        const identity = raw instanceof Promise ? await raw : raw;
        if (!Value.Check(schedulingOperationIdSchema, identity)) {
            throw new Error("Scheduling identity factory returned an invalid identity.");
        }
        return identity;
    }

    #assertWaitRequest(
        wait: SchedulingWaitRecord,
        agentId: string,
        id: string,
        operation: SchedulingOperation,
        kind: "wait" | "wait_until",
        dueAt: number,
        expectedStartedAt: number,
    ): void {
        assertSchedulingWaitRecord(wait);
        if (
            wait.id !== id ||
            wait.agentId !== agentId ||
            wait.operationId !== operation.operationId ||
            wait.fingerprint !== operation.fingerprint ||
            wait.kind !== kind ||
            wait.dueAt !== dueAt ||
            wait.startedAt !== expectedStartedAt
        ) {
            throw new Error("Scheduling durable wait does not match the requested identity.");
        }
        if (wait.status !== "waiting" && wait.status !== "elapsed" && wait.status !== "interrupted") {
            throw new Error("Scheduling durable wait has an invalid status.");
        }
        if (wait.status !== "waiting" && wait.elapsedMs > this.#maxWaitDuration) {
            throw new Error("Scheduling durable wait exceeds the configured bound.");
        }
        if (wait.dueAt - wait.createdAt > this.#maxWaitDuration) {
            throw new Error("Scheduling durable wait exceeds the configured horizon.");
        }
    }

    #assertScheduleRequest(
        schedule: SchedulingScheduledMessage,
        id: string,
        senderAgentId: string,
        targetAgentId: string,
        message: string,
        dueAt: number,
        operationId: string,
        fingerprint: string,
    ): void {
        assertSchedulingScheduledMessage(schedule);
        if (
            schedule.id !== id ||
            schedule.senderAgentId !== senderAgentId ||
            schedule.targetAgentId !== targetAgentId ||
            schedule.message !== message ||
            schedule.dueAt !== dueAt ||
            schedule.operationId !== operationId ||
            schedule.fingerprint !== fingerprint
        ) {
            throw new Error("Scheduled message does not match the requested identity.");
        }
        if (schedule.message.length > this.#maxMessageLength) {
            throw new Error("Scheduled message exceeds the configured bound.");
        }
        if (schedule.dueAt < schedule.createdAt) {
            throw new Error("Scheduled message is due before it was created.");
        }
        if (schedule.dueAt - schedule.createdAt > this.#maxScheduleHorizon) {
            throw new Error("Scheduled message exceeds the configured horizon.");
        }
    }

    #assertScheduleHorizon(schedule: SchedulingScheduledMessage): void {
        if (schedule.dueAt < schedule.createdAt) {
            throw new Error("Scheduled message is due before it was created.");
        }
        if (schedule.dueAt - schedule.createdAt > this.#maxScheduleHorizon) {
            throw new Error("Scheduled message exceeds the configured horizon.");
        }
    }

    #assertScheduleTransitionResult(
        raw: SchedulingScheduledMessage,
        before: SchedulingScheduledMessage,
        after: SchedulingScheduledMessage,
        expectedStatus: "cancelled" | "delivered" | "undelivered",
        deliveryRequest?: SchedulingDeliveryOutcomeInput,
    ): void {
        assertSchedulingScheduledMessage(raw);
        this.#assertScheduleRequest(
            raw,
            before.id,
            before.senderAgentId,
            before.targetAgentId,
            before.message,
            before.dueAt,
            before.operationId,
            before.fingerprint,
        );
        if (!sameJson(raw, after)) {
            throw new Error("Scheduling mutation result disagrees with authoritative state.");
        }
        this.#assertScheduleRequest(
            after,
            before.id,
            before.senderAgentId,
            before.targetAgentId,
            before.message,
            before.dueAt,
            before.operationId,
            before.fingerprint,
        );
        if (before.status !== "pending" || after.status !== expectedStatus) {
            throw new Error("Scheduling mutation did not perform the requested transition.");
        }
        if (expectedStatus !== "cancelled" && after.updatedAt < after.dueAt) {
            throw new Error("Scheduling delivery occurred before the scheduled due time.");
        }
        if (
            expectedStatus === "delivered" &&
            (after.deliveredAt === undefined || after.deliveredAt < after.dueAt)
        ) {
            throw new Error("Scheduling delivery timestamp is before the scheduled due time.");
        }
        if (
            deliveryRequest?.status === "delivered" &&
            deliveryRequest.deliveredAt !== undefined &&
            after.deliveredAt !== deliveryRequest.deliveredAt
        ) {
            throw new Error("Scheduling delivery result changed its requested delivery time.");
        }
        if (
            deliveryRequest?.status === "undelivered" &&
            after.failure !== deliveryRequest.failure
        ) {
            throw new Error("Scheduling delivery result changed its requested failure detail.");
        }
        if (after.updatedAt < before.updatedAt) {
            throw new Error("Scheduling mutation moved its update timestamp backwards.");
        }
    }

    #assertScheduleResult(result: SchedulingMutationResult): asserts result is SchedulingScheduledMessage {
        assertSchedulingScheduledMessage(result);
    }

    #assertPage(
        page: SchedulingSchedulePage,
        requestedCursor: string | undefined,
        requestedLimit: number,
    ): void {
        if (page.limit > requestedLimit || page.schedules.length > page.limit) {
            throw new Error("Scheduling store returned more records than requested.");
        }
        const start = parseCursor(requestedCursor);
        let previous: string | undefined;
        const seen = new Set<string>();
        for (const schedule of page.schedules) {
            if (seen.has(schedule.id) || (previous !== undefined && schedule.id <= previous)) {
                throw new Error("Scheduling page identities must be unique and ordered.");
            }
            seen.add(schedule.id);
            previous = schedule.id;
        }
        if (page.nextCursor !== undefined) {
            const next = parseCursor(page.nextCursor);
            if (page.schedules.length === 0 || next !== start + page.schedules.length) {
                throw new Error("Scheduling page cursor must advance exactly by visible records.");
            }
        }
        if (page.previousCursor !== undefined) {
            const previous = parseCursor(page.previousCursor);
            if (start === 0 || previous >= start) {
                throw new Error("Scheduling page previous cursor did not move backwards.");
            }
        }
        if (
            page.schedules.length === 0 &&
            start > 0 &&
            page.previousCursor === undefined
        ) {
            throw new Error("An empty schedule page beyond the beginning must retain a previous cursor.");
        }
    }

    #fitSchedulePage(
        page: SchedulingSchedulePage,
        requestedCursor?: string,
    ): SchedulingSchedulePage {
        if (page.schedules.length === 0) return structuredClone(page);
        const start = parseCursor(requestedCursor);
        const visible: SchedulingScheduledMessage[] = [];
        for (const schedule of page.schedules) {
            const candidate = [...visible, schedule];
            const nextCursor =
                candidate.length < page.schedules.length || page.nextCursor !== undefined
                    ? String(start + candidate.length)
                    : undefined;
            const candidatePage = {
                schedules: candidate,
                limit: candidate.length,
                ...(nextCursor === undefined ? {} : { nextCursor }),
                ...(page.previousCursor === undefined
                    ? {}
                    : { previousCursor: page.previousCursor }),
            };
            const output = this.#schedulePageText(candidatePage);
            if (output.length > this.#maxOutputCharacters) break;
            visible.push(schedule);
        }
        if (visible.length === 0) {
            throw new Error("Schedule page cannot fit one complete message identity.");
        }
        const consumedAll = visible.length === page.schedules.length;
        const nextCursor =
            consumedAll && page.nextCursor === undefined
                ? undefined
                : String(start + visible.length);
        return {
            schedules: visible,
            limit: visible.length,
            ...(nextCursor === undefined ? {} : { nextCursor }),
            ...(start > 0
                ? {
                      previousCursor:
                          page.previousCursor ?? String(Math.max(0, start - visible.length)),
                  }
                : {}),
        };
    }

    #schedulePageText(page: SchedulingSchedulePage): string {
        const rows = page.schedules.map(
            (schedule) =>
                `${schedule.id} | ${scheduleStatusLabel(schedule.status)} | due ${new Date(
                    schedule.dueAt,
                ).toISOString()}`,
        );
        const full = `${rows.join("\n")}${
            page.previousCursor === undefined
                ? ""
                : `\nEarlier scheduled messages start at cursor ${page.previousCursor}.`
        }${
            page.nextCursor === undefined
                ? ""
                : `\nMore scheduled messages start at cursor ${page.nextCursor}.`
        }`;
        if (full.length <= this.#maxOutputCharacters) return full;

        // Keep every maximum-length identity actionable at the minimum output budget. The
        // optional due-time prose is dropped before the complete identity is ever truncated.
        const compactRows = page.schedules.map(
            (schedule) => `${schedule.id} | ${scheduleStatusLabel(schedule.status)}`,
        );
        return `${compactRows.join("\n")}${
            page.previousCursor === undefined
                ? ""
                : `\nEarlier cursor ${page.previousCursor}.`
        }${
            page.nextCursor === undefined
                ? ""
                : `\nMore cursor ${page.nextCursor}.`
        }`;
    }

    #fitDetailPage(
        page: SchedulingScheduleDetailPage,
    ): SchedulingScheduleDetailPage {
        if (page.schedule === null) return page;
        const outputFor = (detail: string): string => {
            const nextDetailOffset =
                page.detailOffset + detail.length < page.detailTotal
                    ? page.detailOffset + detail.length
                    : undefined;
            return `${page.schedule!.id} | ${scheduleStatusLabel(
                page.schedule!.status,
            )}\n${detail}${
                nextDetailOffset === undefined
                    ? ""
                    : `\nMore detail starts at offset ${nextDetailOffset}.`
            }`;
        };
        if (outputFor(page.detail).length <= this.#maxOutputCharacters) return page;

        let low = 0;
        let high = page.detail.length;
        let best = -1;
        while (low <= high) {
            const midpoint = Math.floor((low + high) / 2);
            if (outputFor(page.detail.slice(0, midpoint)).length <= this.#maxOutputCharacters) {
                best = midpoint;
                low = midpoint + 1;
            } else {
                high = midpoint - 1;
            }
        }
        if (best < 0) {
            throw new Error("Schedule detail cannot fit the model-output bound.");
        }
        const detail = page.detail.slice(0, best);
        return {
            ...page,
            detail,
            ...(page.detailOffset + detail.length < page.detailTotal
                ? { nextDetailOffset: page.detailOffset + detail.length }
                : {}),
        };
    }

    #assertAgentId(value: unknown, label: string): asserts value is string {
        if (!Value.Check(schedulingAgentIdSchema, value)) {
            throw new Error(`Scheduling ${label} ID is invalid.`);
        }
    }

    #assertId(value: unknown, label: string): asserts value is string {
        if (!Value.Check(schedulingMessageIdSchema, value)) {
            throw new Error(`Scheduling ${label} ID is invalid.`);
        }
    }

    #assertTimestamp(value: unknown, label: string): asserts value is number {
        if (!Value.Check(schedulingTimestampSchema(), value)) {
            throw new Error(`Scheduling ${label} is invalid.`);
        }
    }

    #assertInput(schema: unknown, value: unknown, label: string): void {
        if (!Value.Check(schema as Parameters<typeof Value.Check>[0], value)) {
            throw new Error(`Scheduling ${label} is invalid.`);
        }
    }

    #fingerprint(kind: string, agentId: string, input: unknown): string {
        const fingerprint = canonicalJson({ kind, agentId, input });
        if (
            new TextEncoder().encode(fingerprint).byteLength >
            MAX_SCHEDULING_FINGERPRINT_LENGTH
        ) {
            throw new Error("Scheduling fingerprint exceeds its encoded byte bound.");
        }
        if (!Value.Check(schedulingFingerprintSchema, fingerprint)) {
            throw new Error("Scheduling fingerprint is invalid.");
        }
        return fingerprint;
    }
}

export function assertSchedulingFeatureOptions(
    value: unknown,
): asserts value is SchedulingFeatureOptions {
    validateOptions(value);
}

function validateOptions(value: unknown): SchedulingFeatureOptions {
    if (typeof value !== "object" || value === null) {
        throw new Error("Scheduling feature options are invalid.");
    }
    const source = value as Record<string, unknown>;
    const view = {
        ...source,
        store: methodView(source.store, [
            "transaction",
            "afterCommit",
            "readWait",
            "writeWait",
            "readSchedule",
            "writeSchedule",
            "listSchedules",
            "readReceipt",
            "writeReceipt",
            "readMutationProof",
            "writeMutationProof",
        ]),
        ...(source.scheduler === undefined
            ? {}
            : {
                  scheduler: methodView(source.scheduler, [
                      "startWait",
                      "wait",
                      "schedule",
                      "cancel",
                      "reportDelivery",
                  ]),
              }),
        ...(source.authorization === undefined
            ? {}
            : {
                  authorization:
                      typeof source.authorization === "function"
                          ? source.authorization
                          : methodView(source.authorization, ["authorize"]),
              }),
        ...(source.scheduleMessagePolicy === undefined
            ? {}
            : {
                  scheduleMessagePolicy:
                      typeof source.scheduleMessagePolicy === "function"
                          ? source.scheduleMessagePolicy
                          : methodView(source.scheduleMessagePolicy, ["canSchedule"]),
              }),
        ...(source.listener === undefined
            ? {}
            : {
                  listener: methodView(source.listener, [
                      "onEventTransactional",
                      "onEvent",
                  ]),
              }),
    };
    if (!Value.Check(schedulingFeatureOptionsSchema, view)) {
        throw new Error("Scheduling feature options are invalid.");
    }
    return value as SchedulingFeatureOptions;
}

function methodView(value: unknown, keys: readonly string[]): unknown {
    if (typeof value !== "object" || value === null) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const source = value as Record<string, unknown>;
    const view: Record<string, unknown> = {};
    for (const key of keys) view[key] = source[key];
    return view;
}

function isCallScopedAgentKV(
    kv: ReturnType<typeof agentKV>,
): kv is NonNullable<ReturnType<typeof agentKV>> {
    return kv !== undefined && kv.prefix.includes(".call.");
}

function cloneAndFreezeEvent(event: SchedulingEvent): SchedulingEvent {
    if (!Value.Check(schedulingEventSchema, event)) {
        throw new Error("Scheduling feature created an invalid event.");
    }
    return deepFreeze(structuredClone(event));
}

function resultFromWait(wait: SchedulingWaitRecord): SchedulingWaitResult {
    if (wait.status === "waiting") throw new Error("Waiting durable wait has no final result.");
    return {
        waitId: wait.id,
        agentId: wait.agentId,
        operationId: wait.operationId,
        fingerprint: wait.fingerprint,
        outcome: wait.status,
        kind: wait.kind,
        dueAt: wait.dueAt,
        startedAt: wait.startedAt,
        endedAt: wait.finishedAt,
        elapsedMs: wait.elapsedMs,
    };
}

function terminalWaitFromSettlement(
    before: SchedulingWaitRecord,
    settlement: SchedulingWaitSettlement,
    finishedAt: number,
): SchedulingWaitRecord {
    const result = Value.Check(schedulingWaitResultSchema, settlement)
        ? settlement
        : resultFromWait(settlement);
    assertSchedulingWaitResult(result);
    if (
        result.waitId !== before.id ||
        result.agentId !== before.agentId ||
        result.operationId !== before.operationId ||
        result.fingerprint !== before.fingerprint ||
        result.kind !== before.kind ||
        result.dueAt !== before.dueAt ||
        result.startedAt !== before.startedAt
    ) {
        throw new Error("Scheduling wait settlement belongs to another durable wait.");
    }
    if (finishedAt < before.startedAt) {
        throw new Error("Scheduling clock moved before the durable wait started.");
    }
    const settlementClockDrift = finishedAt - result.endedAt;
    if (
        settlementClockDrift < 0 ||
        settlementClockDrift > MAX_SETTLEMENT_CLOCK_DRIFT
    ) {
        throw new Error(
            "Scheduling wait settlement is outside the bounded scheduling clock hand-off window.",
        );
    }
    const elapsedMs = finishedAt - before.startedAt;
    if (result.elapsedMs > elapsedMs) {
        throw new Error(
            "Scheduling wait settlement reports more elapsed time than the scheduling clock.",
        );
    }
    const terminal: SchedulingWaitRecord = {
        ...before,
        status: result.outcome,
        updatedAt: finishedAt,
        finishedAt,
        elapsedMs,
    };
    assertSchedulingWaitRecord(terminal);
    return terminal;
}

function scheduleDetailText(schedule: SchedulingScheduledMessage): string {
    return [
        `Message ID: ${schedule.id}`,
        `Sender agent: ${schedule.senderAgentId}`,
        `Target agent: ${schedule.targetAgentId}`,
        `Status: ${scheduleStatusLabel(schedule.status)}`,
        `Due at: ${new Date(schedule.dueAt).toISOString()}`,
        `Message: ${schedule.message}`,
        `Created at: ${new Date(schedule.createdAt).toISOString()}`,
        `Updated at: ${new Date(schedule.updatedAt).toISOString()}`,
        ...(schedule.deliveredAt === undefined
            ? []
            : [`Delivered at: ${new Date(schedule.deliveredAt).toISOString()}`]),
        ...(schedule.deliveryAttempts === undefined
            ? []
            : [`Delivery attempts: ${schedule.deliveryAttempts}`]),
        ...(schedule.failure === undefined ? [] : [`Failure: ${schedule.failure}`]),
    ].join("\n");
}

function humanDuration(milliseconds: number): string {
    if (milliseconds < 1_000) {
        return formatDurationQuantity(milliseconds, "millisecond", "milliseconds");
    }
    if (milliseconds < 60_000) {
        return formatDurationQuantity(milliseconds / 1_000, "second", "seconds");
    }
    if (milliseconds < 3_600_000) {
        return formatDurationQuantity(milliseconds / 60_000, "minute", "minutes");
    }
    if (milliseconds < 86_400_000) {
        return formatDurationQuantity(milliseconds / 3_600_000, "hour", "hours");
    }
    return formatDurationQuantity(milliseconds / 86_400_000, "day", "days");
}

function formatDurationQuantity(
    value: number,
    singular: string,
    plural: string,
): string {
    const displayed = trimNumber(value);
    return `${displayed} ${Number(displayed) === 1 ? singular : plural}`;
}

function scheduleStatusLabel(
    status: SchedulingScheduledMessage["status"],
): string {
    switch (status) {
        case "pending":
            return "waiting to be delivered";
        case "delivered":
            return "delivered successfully";
        case "undelivered":
            return "not delivered";
        case "cancelled":
            return "cancelled before delivery";
    }
}

function trimNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function isIsoInstant(value: string): boolean {
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(value);
    if (dateParts === null) return false;
    const year = Number(dateParts[1]);
    const month = Number(dateParts[2]);
    const day = Number(dateParts[3]);
    const daysInMonth = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if (
        month < 1 ||
        month > daysInMonth.length ||
        day < 1 ||
        day > (daysInMonth[month - 1] ?? 0)
    ) {
        return false;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}

function parseCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0 || String(value) !== cursor) {
        throw new Error("Scheduling cursor is not a bounded integer.");
    }
    return value;
}

function inferSchedulePageStart(page: SchedulingSchedulePage): number {
    if (page.nextCursor !== undefined) {
        const next = parseCursor(page.nextCursor);
        const start = next - page.schedules.length;
        if (start < 0) throw new Error("Scheduling page cursor precedes its records.");
        return start;
    }
    if (page.previousCursor !== undefined) {
        return parseCursor(page.previousCursor) + page.limit;
    }
    return 0;
}

function canonicalJson(value: unknown, depth = 0): string {
    if (depth > MAX_CANONICAL_DEPTH) throw new Error("Scheduling input is too deeply nested.");
    if (value === null) return "null";
    if (typeof value === "string") {
        if (value.length > MAX_CANONICAL_STRING_LENGTH) {
            throw new Error("Scheduling input contains an oversized string.");
        }
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("Scheduling input has an invalid number.");
        return JSON.stringify(value);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) {
        if (value.length > MAX_CANONICAL_ARRAY_ITEMS) {
            throw new Error("Scheduling input contains too many items.");
        }
        return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).filter(
            ([, entry]) => entry !== undefined,
        );
        if (entries.length > MAX_CANONICAL_OBJECT_PROPERTIES) {
            throw new Error("Scheduling input contains too many properties.");
        }
        return `{${entries
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, depth + 1)}`)
            .join(",")}}`;
    }
    throw new Error("Scheduling input contains an unsupported value.");
}

function sameJson(left: unknown, right: unknown): boolean {
    try {
        return canonicalJson(left) === canonicalJson(right);
    } catch {
        return false;
    }
}

function deepFreeze<ValueType>(value: ValueType): ValueType {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}

function safeError(error: unknown): string {
    try {
        const message =
            error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : String(error);
        return message.slice(0, 512) || "Unknown scheduling observer error.";
    } catch {
        return "Unknown scheduling observer error.";
    }
}

function assertProofTransition(proof: SchedulingMutationProof): void {
    const before = proof.before;
    const after = proof.after;
    if (after === null) {
        throw new Error("Scheduling immutable proof has no authoritative after-state.");
    }
    if (proof.kind === "wait") {
        if (!Value.Check(schedulingWaitRecordSchema, after)) {
            throw new Error("Scheduling wait proof has a non-wait after-state.");
        }
        if (proof.changed) {
            if (
                before === null ||
                !Value.Check(schedulingWaitRecordSchema, before) ||
                before.status !== "waiting" ||
                after.status === "waiting"
            ) {
                throw new Error("Scheduling wait proof does not bind its terminal transition.");
            }
        } else if (before === null || !sameJson(before, after)) {
            throw new Error("Scheduling no-op wait proof changed durable state.");
        }
        return;
    }
    if (!Value.Check(schedulingScheduledMessageSchema, after)) {
        throw new Error("Scheduling message proof has a non-message after-state.");
    }
    if (proof.changed) {
        if (proof.kind === "schedule") {
            if (before !== null || after.status !== "pending") {
                throw new Error("Scheduling create proof does not bind a pending creation.");
            }
        } else if (
            before === null ||
            !Value.Check(schedulingScheduledMessageSchema, before) ||
            before.status !== "pending" ||
            (proof.kind === "cancel"
                ? after.status !== "cancelled"
                : (after.status !== "delivered" && after.status !== "undelivered"))
        ) {
            throw new Error("Scheduling proof does not bind its requested transition.");
        }
    } else if (before === null || !sameJson(before, after)) {
        throw new Error("Scheduling no-op proof changed durable state.");
    }
}

function requirePromise<T>(value: T | Promise<T>, operation: string): Promise<T> {
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    return value;
}
