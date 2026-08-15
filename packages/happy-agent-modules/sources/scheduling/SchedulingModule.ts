import {
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    MAX_SCHEDULING_DETAIL_PAGE_SIZE,
    MAX_SCHEDULING_MESSAGE_LENGTH,
    MAX_SCHEDULING_PAGE_SIZE,
    MAX_SCHEDULING_TIMESTAMP,
    schedulingAgentIdSchema,
    schedulingCancelInputSchema,
    schedulingDeliveryOutcomeInputSchema,
    schedulingDurationSchema,
    schedulingEventIdSchema,
    schedulingInstantSchema,
    schedulingMessageIdSchema,
    schedulingScheduleDetailPageSchema,
    schedulingScheduleDetailQuerySchema,
    schedulingScheduleInputSchema,
    schedulingSchedulePageQuerySchema,
    schedulingSchedulePageSchema,
    schedulingScheduledMessageSchema,
    schedulingTimestampSchema,
    schedulingWaitInputSchema,
    schedulingWaitRecordSchema,
    schedulingWaitResultSchema,
    schedulingWaitUntilInputSchema,
    type SchedulingCancelInput,
    type SchedulingDeliveryOutcomeInput,
    type SchedulingDuration,
    type SchedulingScheduleDetailPage,
    type SchedulingScheduleDetailQuery,
    type SchedulingScheduleInput,
    type SchedulingSchedulePage,
    type SchedulingSchedulePageQuery,
    type SchedulingScheduleToolInput,
    type SchedulingScheduledMessage,
    type SchedulingWaitInput,
    type SchedulingWaitRecord,
    type SchedulingWaitResult,
    type SchedulingWaitSettlement,
    type SchedulingWaitUntilInput,
} from "./Scheduling.js";
import {
    schedulingEventSchema,
    schedulingModuleListenerSchema,
    type SchedulingEvent,
    type SchedulingModuleListener,
} from "./SchedulingEvent.js";
import {
    assertSchedulingScheduledMessage,
    assertSchedulingSettlement,
    assertSchedulingWaitRecord,
    assertSchedulingWaitResult,
    assertSchedulingVoid,
    schedulingContextSchema,
    schedulingSchedulerSchema,
    type SchedulingScheduler,
    type SchedulingStore,
} from "./SchedulingStore.js";
import {
    createSqliteSchedulingStorage,
    schedulingMigrations,
} from "./SqliteSchedulingStorage.js";
import { cancelScheduledMessageTool } from "./tools/cancel_scheduled_message.js";
import { listScheduledMessagesTool } from "./tools/list_scheduled_messages.js";
import { scheduleMessageTool } from "./tools/schedule_message.js";
import { waitTool } from "./tools/wait.js";
import { waitUntilTool } from "./tools/wait_until.js";

const DEFAULT_MAX_WAIT_DURATION = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SCHEDULE_HORIZON = 24 * 60 * 60 * 1_000;
const MAX_CONFIGURED_SCHEDULING_DURATION = 24 * 60 * 60 * 1_000;
const MAX_SETTLEMENT_CLOCK_DRIFT = 60 * 1_000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 8_000;
const DEFAULT_MAX_MESSAGE_LENGTH = MAX_SCHEDULING_MESSAGE_LENGTH;

export const schedulingIdFactorySchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    Type.Union([schedulingMessageIdSchema, Type.Promise(schedulingMessageIdSchema)]),
);
export const schedulingEventIdFactorySchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    Type.Union([schedulingEventIdSchema, Type.Promise(schedulingEventIdSchema)]),
);
export const schedulingClockSchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    schedulingTimestampSchema,
);

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
    Type.Object({ authorize: authorizationFunctionSchema }, { additionalProperties: false }),
]);

const schedulePolicyFunctionSchema = Type.Function(
    [schedulingContextSchema, schedulingAgentIdSchema],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);
export const schedulingMessagePolicySchema = Type.Union([
    schedulePolicyFunctionSchema,
    Type.Object({ canSchedule: schedulePolicyFunctionSchema }, { additionalProperties: false }),
]);

export const schedulingPostCommitErrorSchema = Type.Function(
    [schedulingContextSchema, schedulingEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export const schedulingModuleOptionsSchema = Type.Object(
    {
        scheduler: schedulingSchedulerSchema,
        authorization: Type.Optional(schedulingAuthorizationSchema),
        scheduleMessagePolicy: Type.Optional(schedulingMessagePolicySchema),
        idFactory: Type.Optional(schedulingIdFactorySchema),
        eventIdFactory: Type.Optional(schedulingEventIdFactorySchema),
        clock: Type.Optional(schedulingClockSchema),
        listener: Type.Optional(schedulingModuleListenerSchema),
        maxWaitDuration: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_CONFIGURED_SCHEDULING_DURATION }),
        ),
        maxScheduleHorizon: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_CONFIGURED_SCHEDULING_DURATION }),
        ),
        maxPageSize: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_SCHEDULING_PAGE_SIZE }),
        ),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: 100_000 }),
        ),
        maxMessageLength: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_SCHEDULING_MESSAGE_LENGTH }),
        ),
        onPostCommitError: Type.Optional(schedulingPostCommitErrorSchema),
    },
    { additionalProperties: false },
);

export type SchedulingModuleOptions = Static<typeof schedulingModuleOptionsSchema>;
export type SchedulingAuthorizationAction = Static<
    typeof schedulingAuthorizationActionSchema
>;
export type SchedulingAuthorization = Static<typeof schedulingAuthorizationSchema>;
export type SchedulingMessagePolicy = Static<typeof schedulingMessagePolicySchema>;

export class SchedulingModule implements AgentModule {
    readonly name = "scheduling";
    readonly migrations = schedulingMigrations;

    readonly #store: SchedulingStore;
    readonly #scheduler: SchedulingScheduler;
    readonly #authorization: SchedulingAuthorization | undefined;
    readonly #scheduleMessagePolicy: SchedulingMessagePolicy | undefined;
    readonly #idFactory: NonNullable<SchedulingModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<SchedulingModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<SchedulingModuleOptions["clock"]>;
    readonly #listener: SchedulingModuleListener | undefined;
    readonly #onPostCommitError: SchedulingModuleOptions["onPostCommitError"];
    readonly #maxWaitDuration: number;
    readonly #maxScheduleHorizon: number;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #maxMessageLength: number;

    constructor(options: SchedulingModuleOptions) {
        const validated = validateOptions(options);
        this.#store = createSqliteSchedulingStorage();
        this.#scheduler = validated.scheduler;
        this.#authorization = validated.authorization;
        this.#scheduleMessagePolicy = validated.scheduleMessagePolicy;
        this.#idFactory =
            validated.idFactory ??
            (() => `s${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 31)}`);
        this.#eventIdFactory =
            validated.eventIdFactory ??
            (() => `e${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 31)}`);
        this.#clock = validated.clock ?? (() => Date.now());
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
        scope: AgentModuleScope,
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

    async wait(
        ctx: Context,
        agentId: string,
        input: SchedulingWaitInput,
    ): Promise<SchedulingWaitResult> {
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
        return await this.#schedule(ctx, agentId, input);
    }

    async cancelSchedule(
        ctx: Context,
        agentId: string,
        input: SchedulingCancelInput | string,
    ): Promise<SchedulingScheduledMessage> {
        const normalized = typeof input === "string" ? { scheduleId: input } : input;
        return await this.#cancelSchedule(ctx, agentId, normalized);
    }

    async listSchedulePage(
        ctx: Context,
        agentId: string,
        query: SchedulingSchedulePageQuery = {},
    ): Promise<SchedulingSchedulePage> {
        return await this.#listSchedulePage(ctx, agentId, query);
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
        return await ctx.inTx(async (txCtx) => {
            const schedule = await this.#readSchedule(txCtx, agentId, scheduleId);
            if (schedule === undefined) return undefined;
            await this.#authorize(txCtx, agentId, schedule.senderAgentId, "read");
            return structuredClone(schedule);
        });
    }

    async getSchedulePage(
        ctx: Context,
        agentId: string,
        scheduleId: string,
        query: SchedulingScheduleDetailQuery = {},
    ): Promise<SchedulingScheduleDetailPage> {
        this.#assertInput(schedulingScheduleDetailQuerySchema, query, "schedule detail query");
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
        return this.#fitDetailPage({
            schedule,
            detail: detail.slice(offset, offset + limit),
            detailOffset: offset,
            detailTotal: detail.length,
            ...(offset + limit < detail.length ? { nextDetailOffset: offset + limit } : {}),
        });
    }

    async reportDeliveryOutcome(
        ctx: Context,
        agentId: string,
        input: SchedulingDeliveryOutcomeInput,
    ): Promise<SchedulingScheduledMessage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingDeliveryOutcomeInputSchema, input, "delivery outcome");
        const before = await ctx.inTx(async (txCtx) => {
            const before = await this.#readRequiredSchedule(txCtx, agentId, input.scheduleId);
            await this.#authorize(txCtx, agentId, before.senderAgentId, "delivery");
            return structuredClone(before);
        });
        if (before.status !== "pending") return before;
        const raw = await this.#scheduler.reportDelivery(ctx, agentId, input);
        assertSchedulingScheduledMessage(raw);
        this.#assertScheduleTransition(raw, before, input.status, input);
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredSchedule(txCtx, agentId, input.scheduleId);
            if (current.status !== "pending") {
                if (!sameSchedule(current, raw)) {
                    throw new Error("Delivery outcome retry disagrees with durable state.");
                }
                return current;
            }
            this.#assertScheduleTransition(raw, current, input.status, input);
            await this.#writeSchedule(txCtx, raw);
            const event = await this.#event(txCtx, {
                type: "scheduled_message_delivery_outcome",
                agentId,
                schedule: raw,
            });
            await this.#announce(txCtx, event);
            return structuredClone(raw);
        });
    }

    formatWaitForModel(result: SchedulingWaitResult): string {
        assertSchedulingWaitResult(result);
        const elapsed = humanDuration(result.elapsedMs);
        return result.outcome === "interrupted"
            ? `Wait ${result.waitId} was interrupted; ${elapsed} actually elapsed.`
            : `Wait ${result.waitId} elapsed after ${elapsed}.`;
    }

    formatScheduleForModel(schedule: SchedulingScheduledMessage): string {
        assertSchedulingScheduledMessage(schedule);
        const compact = `Scheduled message ${schedule.id} is ${scheduleStatusLabel(
            schedule.status,
        )}; due ${new Date(schedule.dueAt).toISOString()}.`;
        if (compact.length <= this.#maxOutputCharacters) return compact;
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
        const visible = this.#fitSchedulePage(page, String(inferSchedulePageStart(page)));
        if (visible.schedules.length === 0) return "No scheduled messages.";
        return this.#schedulePageText(visible);
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
        if (detailPage === undefined) throw new Error("Cannot format an invalid schedule detail.");
        if (detailPage.schedule === null) return "That scheduled message does not exist.";
        return `${detailPage.schedule.id} | ${scheduleStatusLabel(
            detailPage.schedule.status,
        )}\n${detailPage.detail}${
            detailPage.nextDetailOffset === undefined
                ? ""
                : `\nMore detail starts at offset ${detailPage.nextDetailOffset}.`
        }`;
    }

    formatForModel(
        result:
            | SchedulingWaitResult
            | SchedulingScheduledMessage
            | SchedulingSchedulePage
            | SchedulingScheduleDetailPage,
    ): string {
        if (Value.Check(schedulingWaitResultSchema, result)) return this.formatWaitForModel(result);
        if (Value.Check(schedulingSchedulePageSchema, result)) {
            return this.formatSchedulePageForModel(result);
        }
        if (Value.Check(schedulingScheduleDetailPageSchema, result)) {
            return this.formatScheduleDetailPageForModel(result);
        }
        return this.formatScheduleForModel(result as SchedulingScheduledMessage);
    }

    async #schedule(
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
        const request = await ctx.inTx(async (txCtx) => {
            const id = input.id ?? (await this.#newIdentity(txCtx, agentId));
            this.#assertId(id, "schedule");
            if ((await this.#readSchedule(txCtx, agentId, id)) !== undefined) {
                throw new Error(`Scheduled message "${id}" already exists.`);
            }
            const dueAt = this.#dueAtFromSchedule(this.#now(txCtx, agentId), input);
            return {
                id,
                senderAgentId: agentId,
                targetAgentId,
                message: input.message,
                dueAt,
            };
        });
        const raw = await this.#scheduler.schedule(ctx, agentId, request);
        assertSchedulingScheduledMessage(raw);
        this.#assertScheduleRequest(
            raw,
            request.id,
            agentId,
            targetAgentId,
            input.message,
            request.dueAt,
        );
        if (raw.status !== "pending") {
            throw new Error("Scheduling scheduler returned a non-pending new message.");
        }
        return await ctx.inTx(async (txCtx) => {
            const existing = await this.#readSchedule(txCtx, agentId, request.id);
            if (existing !== undefined) {
                if (!sameSchedule(existing, raw)) {
                    throw new Error("Scheduled message retry disagrees with durable state.");
                }
                return existing;
            }
            await this.#writeSchedule(txCtx, raw);
            const event = await this.#event(txCtx, {
                type: "message_scheduled",
                agentId,
                schedule: raw,
            });
            await this.#announce(txCtx, event);
            return structuredClone(raw);
        });
    }

    async #cancelSchedule(
        ctx: Context,
        agentId: string,
        input: SchedulingCancelInput,
    ): Promise<SchedulingScheduledMessage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingCancelInputSchema, input, "schedule cancellation");
        const before = await ctx.inTx(async (txCtx) => {
            const before = await this.#readRequiredSchedule(txCtx, agentId, input.scheduleId);
            await this.#authorize(txCtx, agentId, before.senderAgentId, "cancel");
            return structuredClone(before);
        });
        if (before.status !== "pending") return before;
        const raw = await this.#scheduler.cancel(ctx, agentId, input);
        assertSchedulingScheduledMessage(raw);
        this.#assertScheduleTransition(raw, before, "cancelled");
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredSchedule(txCtx, agentId, input.scheduleId);
            if (current.status !== "pending") {
                if (!sameSchedule(current, raw)) {
                    throw new Error("Schedule cancellation retry disagrees with durable state.");
                }
                return current;
            }
            this.#assertScheduleTransition(raw, current, "cancelled");
            await this.#writeSchedule(txCtx, raw);
            const event = await this.#event(txCtx, {
                type: "scheduled_message_cancelled",
                agentId,
                schedule: raw,
            });
            await this.#announce(txCtx, event);
            return structuredClone(raw);
        });
    }

    async #listSchedulePage(
        ctx: Context,
        agentId: string,
        query: SchedulingSchedulePageQuery,
    ): Promise<SchedulingSchedulePage> {
        this.#assertAgentId(agentId, "acting agent");
        this.#assertInput(schedulingSchedulePageQuerySchema, query, "schedule page query");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Schedule page limit cannot exceed ${this.#maxPageSize}.`);
        }
        const senderAgentId = query.senderAgentId ?? agentId;
        await this.#authorize(ctx, agentId, senderAgentId, "list");
        return await ctx.inTx(async (txCtx) => {
            const page = await this.#store.listSchedules(txCtx, agentId, {
                ...query,
                limit,
                senderAgentId,
            });
            if (!Value.Check(schedulingSchedulePageSchema, page)) {
                throw new Error("Scheduling store returned an invalid schedule page.");
            }
            this.#assertPage(page, query.cursor, limit);
            for (const schedule of page.schedules) {
                assertSchedulingScheduledMessage(schedule);
                if (schedule.senderAgentId !== senderAgentId) {
                    throw new Error("Scheduling page returned a message outside the sender filter.");
                }
            }
            return structuredClone(this.#fitSchedulePage(page, query.cursor));
        });
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
        const id = input.id ?? (await this.#newIdentity(ctx, agentId));
        this.#assertId(id, "wait");
        const planned = await ctx.inTx(async (txCtx) => {
            const existing = await this.#readWait(txCtx, agentId, id);
            if (existing !== undefined) {
                if (existing.kind !== kind) {
                    throw new Error("Scheduling wait identity belongs to another wait kind.");
                }
                return { existing: structuredClone(existing) } as const;
            }
            const startedAt = this.#now(txCtx, agentId);
            const dueAt =
                "duration" in input
                    ? this.#dueAtFromDuration(startedAt, input.duration)
                    : this.#dueAtFromInstant(startedAt, input.at);
            return {
                request: {
                    id,
                    agentId,
                    kind,
                    dueAt,
                    startedAt,
                },
            } as const;
        });
        let claimed: SchedulingWaitRecord;
        if ("existing" in planned) {
            if (planned.existing.status !== "waiting") {
                return resultFromWait(planned.existing);
            }
            claimed = planned.existing;
        } else {
            const raw = await this.#scheduler.startWait(ctx, agentId, planned.request);
            assertSchedulingWaitRecord(raw);
            this.#assertWaitRequest(
                raw,
                agentId,
                id,
                kind,
                planned.request.dueAt,
                planned.request.startedAt,
            );
            if (raw.status !== "waiting") {
                throw new Error("Scheduling scheduler returned a terminal wait while claiming.");
            }
            claimed = await ctx.inTx(async (txCtx) => {
                const existing = await this.#readWait(txCtx, agentId, id);
                if (existing !== undefined) return existing;
                await this.#writeWait(txCtx, raw);
                const event = await this.#event(txCtx, {
                    type: "wait_started",
                    agentId,
                    wait: raw,
                });
                await this.#announce(txCtx, event);
                return structuredClone(raw);
            });
        }
        assertSchedulingWaitRecord(claimed);
        const settlement = await this.#scheduler.wait(ctx, agentId, id);
        assertSchedulingSettlement(settlement);
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#readRequiredWait(txCtx, agentId, id);
            if (before.status !== "waiting") {
                return resultFromWait(before);
            }
            const terminal = terminalWaitFromSettlement(
                before,
                settlement,
                this.#now(txCtx, agentId),
            );
            await this.#writeWait(txCtx, terminal);
            const result = resultFromWait(terminal);
            const event = await this.#event(txCtx, {
                type: "wait_finished",
                agentId,
                wait: terminal,
                result,
            });
            await this.#announce(txCtx, event);
            return result;
        });
    }

    async #readWait(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord | undefined> {
        const wait = await this.#store.readWait(ctx, agentId, id);
        if (wait === undefined) return undefined;
        assertSchedulingWaitRecord(wait);
        if (wait.id !== id || wait.agentId !== agentId) {
            throw new Error("Scheduling store returned a different durable wait identity.");
        }
        return structuredClone(wait);
    }

    async #readRequiredWait(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord> {
        const wait = await this.#readWait(ctx, agentId, id);
        if (wait === undefined) throw new Error(`Scheduling wait "${id}" does not exist.`);
        return wait;
    }

    async #writeWait(ctx: Context, wait: SchedulingWaitRecord): Promise<void> {
        assertSchedulingWaitRecord(wait);
        await this.#store.writeWait(ctx, structuredClone(wait));
    }

    async #readSchedule(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingScheduledMessage | undefined> {
        const schedule = await this.#store.readSchedule(ctx, agentId, id);
        if (schedule === undefined) return undefined;
        assertSchedulingScheduledMessage(schedule);
        if (schedule.id !== id) {
            throw new Error("Scheduling store returned a different scheduled message identity.");
        }
        return structuredClone(schedule);
    }

    async #readRequiredSchedule(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingScheduledMessage> {
        const schedule = await this.#readSchedule(ctx, agentId, id);
        if (schedule === undefined) throw new Error(`Scheduled message "${id}" does not exist.`);
        return schedule;
    }

    async #writeSchedule(ctx: Context, schedule: SchedulingScheduledMessage): Promise<void> {
        assertSchedulingScheduledMessage(schedule);
        await this.#store.writeSchedule(ctx, structuredClone(schedule));
    }

    async #event(
        ctx: Context,
        payload:
            | {
                  readonly type: "wait_started";
                  readonly agentId: string;
                  readonly wait: SchedulingWaitRecord;
              }
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
        const raw = this.#eventIdFactory(ctx, payload.agentId);
        const eventId = raw instanceof Promise ? await raw : raw;
        if (!Value.Check(schedulingEventIdSchema, eventId)) {
            throw new Error("Scheduling event identity factory returned an invalid ID.");
        }
        const event = { ...payload, eventId, at: this.#now(ctx, payload.agentId) };
        if (!Value.Check(schedulingEventSchema, event)) {
            throw new Error("Scheduling module created an invalid event.");
        }
        return deepFreeze(structuredClone(event as SchedulingEvent));
    }

    async #announce(ctx: Context, event: SchedulingEvent): Promise<void> {
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            assertSchedulingVoid(
                await transactional.call(this.#listener, ctx, event),
                "transactional listener",
            );
        }
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: SchedulingEvent): Promise<void> {
        try {
            const listener = this.#listener?.onEvent;
            if (listener !== undefined) {
                assertSchedulingVoid(
                    await listener.call(this.#listener, ctx, event),
                    "post-commit listener",
                );
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
                // Post-commit observation cannot undo durable state.
            }
        }
    }

    async #maySchedule(ctx: Context, agentId: string): Promise<boolean> {
        if (this.#scheduleMessagePolicy === undefined) return true;
        const owner = this.#scheduleMessagePolicy;
        const policy = typeof owner === "function" ? owner : owner.canSchedule;
        const raw = policy.call(typeof owner === "function" ? undefined : owner, ctx, agentId);
        const allowed = raw instanceof Promise ? await raw : raw;
        if (typeof allowed !== "boolean") {
            throw new Error("Scheduling message policy returned a non-boolean result.");
        }
        return allowed;
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
        const owner = this.#authorization;
        const policy = typeof owner === "function" ? owner : owner.authorize;
        const raw = policy.call(
            typeof owner === "function" ? undefined : owner,
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

    async #newIdentity(ctx: Context, agentId: string): Promise<string> {
        const raw = this.#idFactory(ctx, agentId);
        const id = raw instanceof Promise ? await raw : raw;
        if (!Value.Check(schedulingMessageIdSchema, id)) {
            throw new Error("Scheduling identity factory returned an invalid identity.");
        }
        return id;
    }

    #now(ctx: Context, agentId: string): number {
        const now = this.#clock(ctx, agentId);
        if (!Value.Check(schedulingTimestampSchema, now)) {
            throw new Error("Scheduling clock value is invalid.");
        }
        return now;
    }

    #dueAtFromSchedule(now: number, input: SchedulingScheduleInput): number {
        return "in" in input
            ? this.#dueAtFromDuration(now, input.in, this.#maxScheduleHorizon)
            : this.#dueAtFromInstant(now, input.at, this.#maxScheduleHorizon);
    }

    #dueAtFromDuration(
        now: number,
        duration: SchedulingDuration,
        horizon = this.#maxWaitDuration,
    ): number {
        if (!Value.Check(schedulingDurationSchema, duration)) {
            throw new Error("Scheduling duration is invalid.");
        }
        const unit =
            "unit" in duration
                ? duration.unit.replace(/s$/u, "")
                : "seconds" in duration
                  ? "second"
                  : "minutes" in duration
                    ? "minute"
                    : "hours" in duration
                      ? "hour"
                      : "day";
        const value =
            "unit" in duration
                ? duration.value
                : "seconds" in duration
                  ? duration.seconds
                  : "minutes" in duration
                    ? duration.minutes
                    : "hours" in duration
                      ? duration.hours
                      : duration.days;
        const multiplier =
            unit === "second"
                ? 1_000
                : unit === "minute"
                  ? 60_000
                  : unit === "hour"
                    ? 3_600_000
                    : 86_400_000;
        const amount = value * multiplier;
        if (!Number.isSafeInteger(amount) || amount < 0) {
            throw new Error(
                "Scheduling duration must resolve to a finite whole number of milliseconds.",
            );
        }
        if (amount > horizon) {
            throw new Error(`Scheduling duration cannot exceed ${humanDuration(horizon)}.`);
        }
        const dueAt = now + amount;
        if (!Value.Check(schedulingTimestampSchema, dueAt)) {
            throw new Error("Scheduling due time is invalid.");
        }
        return dueAt;
    }

    #dueAtFromInstant(now: number, instant: string, horizon = this.#maxWaitDuration): number {
        if (!Value.Check(schedulingInstantSchema, instant) || !isIsoInstant(instant)) {
            throw new Error("Scheduling time must be a valid ISO 8601 instant.");
        }
        const dueAt = Date.parse(instant);
        if (!Value.Check(schedulingTimestampSchema, dueAt)) {
            throw new Error("Scheduling due time is invalid.");
        }
        if (dueAt < now) throw new Error("Scheduling time is in the past.");
        if (dueAt - now > horizon) {
            throw new Error(`Scheduling time cannot be more than ${humanDuration(horizon)} away.`);
        }
        return dueAt;
    }

    #assertWaitRequest(
        wait: SchedulingWaitRecord,
        agentId: string,
        id: string,
        kind: "wait" | "wait_until",
        dueAt: number,
        startedAt: number,
    ): void {
        assertSchedulingWaitRecord(wait);
        if (
            wait.id !== id ||
            wait.agentId !== agentId ||
            wait.kind !== kind ||
            wait.dueAt !== dueAt ||
            wait.startedAt !== startedAt
        ) {
            throw new Error("Scheduling durable wait does not match the requested wait.");
        }
    }

    #assertScheduleRequest(
        schedule: SchedulingScheduledMessage,
        id: string,
        senderAgentId: string,
        targetAgentId: string,
        message: string,
        dueAt: number,
    ): void {
        assertSchedulingScheduledMessage(schedule);
        if (
            schedule.id !== id ||
            schedule.senderAgentId !== senderAgentId ||
            schedule.targetAgentId !== targetAgentId ||
            schedule.message !== message ||
            schedule.dueAt !== dueAt
        ) {
            throw new Error("Scheduled message does not match the requested message.");
        }
        if (schedule.dueAt - schedule.createdAt > this.#maxScheduleHorizon) {
            throw new Error("Scheduled message exceeds the configured horizon.");
        }
    }

    #assertScheduleTransition(
        after: SchedulingScheduledMessage,
        before: SchedulingScheduledMessage,
        status: "cancelled" | "delivered" | "undelivered",
        request?: SchedulingDeliveryOutcomeInput,
    ): void {
        this.#assertScheduleRequest(
            after,
            before.id,
            before.senderAgentId,
            before.targetAgentId,
            before.message,
            before.dueAt,
        );
        if (before.status !== "pending" || after.status !== status) {
            throw new Error("Scheduling mutation did not perform the requested transition.");
        }
        if (request?.status === "undelivered" && after.failure !== request.failure) {
            throw new Error("Scheduling delivery result changed its failure detail.");
        }
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
        if (
            page.nextCursor !== undefined &&
            parseCursor(page.nextCursor) !== start + page.schedules.length
        ) {
            throw new Error("Scheduling page cursor did not advance by visible records.");
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
            if (
                this.#schedulePageText({
                    schedules: candidate,
                    limit: candidate.length,
                    ...(candidate.length < page.schedules.length ||
                    page.nextCursor !== undefined
                        ? { nextCursor: String(start + candidate.length) }
                        : {}),
                    ...(page.previousCursor === undefined
                        ? {}
                        : { previousCursor: page.previousCursor }),
                }).length > this.#maxOutputCharacters
            ) {
                break;
            }
            visible.push(schedule);
        }
        if (visible.length === 0) {
            throw new Error("Schedule page cannot fit one complete message identity.");
        }
        return {
            schedules: visible,
            limit: visible.length,
            ...(visible.length < page.schedules.length || page.nextCursor !== undefined
                ? { nextCursor: String(start + visible.length) }
                : {}),
            ...(page.previousCursor === undefined
                ? {}
                : { previousCursor: page.previousCursor }),
        };
    }

    #schedulePageText(page: SchedulingSchedulePage): string {
        return `${page.schedules
            .map(
                (schedule) =>
                    `${schedule.id} | ${scheduleStatusLabel(schedule.status)} | due ${new Date(
                        schedule.dueAt,
                    ).toISOString()}`,
            )
            .join("\n")}${
            page.previousCursor === undefined
                ? ""
                : `\nEarlier scheduled messages start at cursor ${page.previousCursor}.`
        }${
            page.nextCursor === undefined
                ? ""
                : `\nMore scheduled messages start at cursor ${page.nextCursor}.`
        }`;
    }

    #fitDetailPage(page: SchedulingScheduleDetailPage): SchedulingScheduleDetailPage {
        if (page.schedule === null) return page;
        const overhead =
            `${page.schedule.id} | ${scheduleStatusLabel(page.schedule.status)}\n`.length + 64;
        const available = Math.max(0, this.#maxOutputCharacters - overhead);
        const detail = page.detail.slice(0, available);
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

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Scheduling ${label} is invalid.`);
    }
}

export function assertSchedulingModuleOptions(
    value: unknown,
): asserts value is SchedulingModuleOptions {
    validateOptions(value);
}

function validateOptions(value: unknown): SchedulingModuleOptions {
    if (typeof value !== "object" || value === null) {
        throw new Error("Scheduling module options are invalid.");
    }
    const source = value as Record<string, unknown>;
    const view = {
        ...source,
        scheduler: methodView(source.scheduler, [
            "startWait",
            "wait",
            "schedule",
            "cancel",
            "reportDelivery",
        ]),
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
                  listener: methodView(source.listener, ["onEventTransactional", "onEvent"]),
              }),
    };
    if (!Value.Check(schedulingModuleOptionsSchema, view)) {
        throw new Error("Scheduling module options are invalid.");
    }
    return value as SchedulingModuleOptions;
}

function methodView(value: unknown, keys: readonly string[]): unknown {
    if (typeof value !== "object" || value === null) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const source = value as Record<string, unknown>;
    return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function resultFromWait(wait: SchedulingWaitRecord): SchedulingWaitResult {
    if (wait.status === "waiting") throw new Error("Waiting durable wait has no final result.");
    return {
        waitId: wait.id,
        agentId: wait.agentId,
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
        ? (settlement as SchedulingWaitResult)
        : resultFromWait(settlement as SchedulingWaitRecord);
    assertSchedulingWaitResult(result);
    if (
        result.waitId !== before.id ||
        result.agentId !== before.agentId ||
        result.kind !== before.kind ||
        result.dueAt !== before.dueAt ||
        result.startedAt !== before.startedAt
    ) {
        throw new Error("Scheduling wait settlement belongs to another durable wait.");
    }
    const drift = finishedAt - result.endedAt;
    if (drift < 0 || drift > MAX_SETTLEMENT_CLOCK_DRIFT) {
        throw new Error("Scheduling wait settlement is outside the scheduling clock window.");
    }
    const terminal: SchedulingWaitRecord = {
        ...before,
        status: result.outcome,
        updatedAt: finishedAt,
        finishedAt,
        elapsedMs: finishedAt - before.startedAt,
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
        ...(schedule.failure === undefined ? [] : [`Failure: ${schedule.failure}`]),
    ].join("\n");
}

function humanDuration(milliseconds: number): string {
    if (milliseconds < 1_000) return `${milliseconds} milliseconds`;
    if (milliseconds < 60_000) return quantity(milliseconds / 1_000, "second");
    if (milliseconds < 3_600_000) return quantity(milliseconds / 60_000, "minute");
    if (milliseconds < 86_400_000) return quantity(milliseconds / 3_600_000, "hour");
    return quantity(milliseconds / 86_400_000, "day");
}

function quantity(value: number, unit: string): string {
    const shown = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "");
    return `${shown} ${Number(shown) === 1 ? unit : `${unit}s`}`;
}

function scheduleStatusLabel(status: SchedulingScheduledMessage["status"]): string {
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

function isIsoInstant(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(value);
    if (match === null) return false;
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
        return parseCursor(page.nextCursor) - page.schedules.length;
    }
    if (page.previousCursor !== undefined) {
        return parseCursor(page.previousCursor) + page.limit;
    }
    return 0;
}

function deepFreeze<ValueType>(value: ValueType): ValueType {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}

function safeError(error: unknown): string {
    const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
    return message.slice(0, 512) || "Unknown scheduling observer error.";
}

function sameSchedule(
    left: SchedulingScheduledMessage,
    right: SchedulingScheduledMessage,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}