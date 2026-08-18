import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    defineAgentTool,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, asyncLock, type Context } from "@steve.kite/stdlib";

import {
    MAX_HAPPY_NOTIFICATIONS,
    happyAgentIdSchema,
    happyDeliveryResultSchema,
    happyModuleEventSchema,
    happyNotificationInputSchema,
    happyNotificationSchema,
    happyNotificationToolInputSchema,
    happyStatusInputSchema,
    happyStatusRecordSchema,
    happyStatusToolInputSchema,
    type HappyModuleEvent,
    type HappyNotification,
    type HappyNotificationInput,
    type HappyStatusInput,
    type HappyStatusRecord,
} from "./Happy.js";
import {
    checkedHappyHost,
    happyHostSchema,
    happyHostShape,
    type HappyHost,
} from "./HappyHost.js";

const exact = { additionalProperties: false } as const;
const contextSchema = Type.Unsafe<Context>(Type.Object({}, exact));
const eventListenerSchema = Type.Function(
    [contextSchema, happyModuleEventSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
const errorListenerSchema = Type.Function(
    [contextSchema, happyModuleEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
const idFactorySchema = Type.Function([], Type.String({ minLength: 1, maxLength: 128 }));
const clockSchema = Type.Function([], Type.Integer({ minimum: 0 }));

export const happyModuleOptionsSchema = Type.Object(
    {
        clock: Type.Optional(clockSchema),
        eventIdFactory: Type.Optional(idFactorySchema),
        host: happyHostSchema,
        idFactory: Type.Optional(idFactorySchema),
        listener: Type.Optional(eventListenerSchema),
        onPostCommitError: Type.Optional(errorListenerSchema),
    },
    exact,
);
export type HappyModuleOptions = Static<typeof happyModuleOptionsSchema>;

const migration = [
    "001-happy-state",
    async (_ctx: Context, database: AgentDatabase) => {
        await agentDatabaseRun(
            database,
            sql`CREATE TABLE IF NOT EXISTS happy_module_status (
                agent_id TEXT PRIMARY KEY NOT NULL,
                operation_id TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT,
                updated_at BIGINT NOT NULL
            )`,
        );
        await agentDatabaseRun(
            database,
            sql`CREATE TABLE IF NOT EXISTS happy_module_notifications (
                agent_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                notification_id TEXT NOT NULL,
                title TEXT,
                body TEXT NOT NULL,
                level TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                PRIMARY KEY (agent_id, operation_id),
                UNIQUE (notification_id)
            )`,
        );
        await agentDatabaseRun(
            database,
            sql`CREATE TABLE IF NOT EXISTS happy_module_status_operations (
                agent_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT,
                updated_at BIGINT NOT NULL,
                PRIMARY KEY (agent_id, operation_id)
            )`,
        );
    },
] as const;

/** Durable notifications and status updates for Happy clients. */
export class HappyModule implements AgentModule {
    readonly name = "happy";
    readonly migrations = [migration];

    readonly #host: HappyHost;
    readonly #clock: () => number;
    readonly #idFactory: () => string;
    readonly #eventIdFactory: () => string;
    readonly #listener: HappyModuleOptions["listener"];
    readonly #onPostCommitError: HappyModuleOptions["onPostCommitError"];
    // One writer at a time: two callers must not open competing transactions on the same storage.
    readonly #writes = asyncLock({ reentry: "allow" });

    constructor(options: HappyModuleOptions) {
        if (!Value.Check(happyModuleOptionsSchema, optionsShape(options))) {
            throw new Error("Happy module options are invalid.");
        }
        this.#host = checkedHappyHost(options.host);
        this.#clock = options.clock ?? Date.now;
        this.#idFactory = options.idFactory ?? (() => `happy-${randomUUID()}`);
        this.#eventIdFactory = options.eventIdFactory ?? (() => `happy-event-${randomUUID()}`);
        this.#listener = options.listener;
        this.#onPostCommitError = options.onPostCommitError;
    }

    async notify(
        ctx: Context,
        agentId: string,
        input: HappyNotificationInput,
    ): Promise<HappyNotification> {
        assertAgentId(agentId);
        assertInput(happyNotificationInputSchema, input, "Happy notification input");
        return await this.#writes.runInLock(ctx, async (lockCtx) => {
            return await lockCtx.inTx(async (txCtx) => {
                const notification: HappyNotification = {
                    body: input.body,
                    createdAt: this.#clock(),
                    id: this.#idFactory(),
                    level: input.level ?? "info",
                    ...(input.title === undefined ? {} : { title: input.title }),
                };
                assertInput(happyNotificationSchema, notification, "Happy notification");
                await agentDatabaseRun(
                    txCtx.db,
                    sql`INSERT INTO happy_module_notifications
                        (agent_id, operation_id, notification_id, title, body, level, created_at)
                        VALUES (${agentId}, ${notification.id}, ${notification.id},
                            ${notification.title ?? null}, ${notification.body},
                            ${notification.level}, ${notification.createdAt})`,
                );
                const event: HappyModuleEvent = {
                    type: "happy_notification_created",
                    at: notification.createdAt,
                    eventId: this.#eventIdFactory(),
                    notification,
                };
                assertInput(happyModuleEventSchema, event, "Happy event");
                this.#publishAfterCommit(ctx, txCtx, event, async (postCommitCtx) => {
                    const delivery = await this.#host.notify(
                        postCommitCtx,
                        agentId,
                        structuredClone(notification),
                    );
                    assertInput(happyDeliveryResultSchema, delivery, "Happy delivery result");
                });
                return notification;
            });
        });
    }

    async setStatus(
        ctx: Context,
        agentId: string,
        input: HappyStatusInput,
    ): Promise<HappyStatusRecord> {
        return await this.#applyStatus(ctx, agentId, input);
    }

    async getStatus(ctx: Context, agentId: string): Promise<HappyStatusRecord | undefined> {
        assertAgentId(agentId);
        return await this.#findStatus(ctx, agentId);
    }

    async listNotifications(
        ctx: Context,
        agentId: string,
        limit = MAX_HAPPY_NOTIFICATIONS,
    ): Promise<readonly HappyNotification[]> {
        assertAgentId(agentId);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HAPPY_NOTIFICATIONS) {
            throw new Error("Happy notification limit is invalid.");
        }
        const rows = await agentDatabaseRows<NotificationRow>(
            ctx.db,
            sql`SELECT notification_id, title, body, level, created_at
                FROM happy_module_notifications
                WHERE agent_id = ${agentId}
                ORDER BY created_at DESC
                LIMIT ${limit}`,
        );
        return rows.map((row) => parseNotification(row));
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: (): string =>
            "Happy is the connected client. Use notify_happy for an explicit user-visible notification and set_happy_status to keep the client status current. Keep notifications concise and never include secrets.",

        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            defineAgentTool({
                name: "notify_happy",
                description:
                    "Send a concise user-visible notification to the connected Happy client.",
                parameters: happyNotificationToolInputSchema,
                returnType: happyNotificationSchema,
                durable: false,
                transactional: true,
                shouldReviewInAutoMode: () => false,
                execute: async (ctx, input) => await this.notify(ctx, scope.agent.id, input),
                toLLM: (result) => [{ type: "text", text: formatNotification(result) }],
            }),
            defineAgentTool({
                name: "set_happy_status",
                description:
                    "Set the short status shown for this agent in the connected Happy client.",
                parameters: happyStatusToolInputSchema,
                returnType: happyStatusRecordSchema,
                durable: true,
                transactional: true,
                shouldReviewInAutoMode: () => false,
                execute: async (ctx, input, call) =>
                    await this.#applyStatus(ctx, scope.agent.id, input, call.id),
                toLLM: (result) => [{ type: "text", text: formatStatus(result) }],
            }),
            defineAgentTool({
                name: "get_happy_status",
                description: "Read the status currently shown for this agent in Happy.",
                parameters: Type.Object({}, exact),
                returnType: Type.Union([happyStatusRecordSchema, Type.Null()]),
                shouldReviewInAutoMode: () => false,
                execute: async (ctx) => (await this.getStatus(ctx, scope.agent.id)) ?? null,
                toLLM: (result) => [
                    {
                        type: "text",
                        text: result === null ? "No Happy status." : formatStatus(result),
                    },
                ],
            }),
        ],
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /**
     * Apply one status operation. `operationId` names the operation durably, so running the same
     * operation again restores exactly what it recorded and delivers nothing a second time.
     */
    async #applyStatus(
        ctx: Context,
        agentId: string,
        input: HappyStatusInput,
        operationId?: string,
    ): Promise<HappyStatusRecord> {
        assertAgentId(agentId);
        assertInput(happyStatusInputSchema, input, "Happy status input");
        return await this.#writes.runInLock(ctx, async (lockCtx) => {
            return await lockCtx.inTx(async (txCtx) => {
                const operation = operationId ?? this.#idFactory();
                const recorded = await this.#findStatusOperation(txCtx, agentId, operation);
                if (recorded !== undefined) {
                    await this.#writeStatus(txCtx, operation, recorded);
                    return recorded;
                }

                const previous = await this.#findStatus(txCtx, agentId);
                const current: HappyStatusRecord = {
                    agentId,
                    status: input.status,
                    updatedAt: this.#clock(),
                    ...(input.message === undefined ? {} : { message: input.message }),
                };
                if (previous !== undefined && sameStatus(previous, current)) return previous;

                const event: HappyModuleEvent = {
                    type: "happy_status_changed",
                    at: current.updatedAt,
                    eventId: this.#eventIdFactory(),
                    ...(previous === undefined ? {} : { previous }),
                    current,
                };
                assertInput(happyModuleEventSchema, event, "Happy event");
                await this.#writeStatus(txCtx, operation, current);
                await agentDatabaseRun(
                    txCtx.db,
                    sql`INSERT INTO happy_module_status_operations
                        (agent_id, operation_id, status, message, updated_at)
                        VALUES (${agentId}, ${operation}, ${current.status},
                            ${current.message ?? null}, ${current.updatedAt})`,
                );
                this.#publishAfterCommit(ctx, txCtx, event, async (postCommitCtx) => {
                    const delivery = await this.#host.setStatus(
                        postCommitCtx,
                        agentId,
                        structuredClone(current),
                    );
                    assertInput(happyDeliveryResultSchema, delivery, "Happy delivery result");
                });
                return current;
            });
        });
    }

    async #writeStatus(
        ctx: Context,
        operationId: string,
        status: HappyStatusRecord,
    ): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_module_status
                (agent_id, operation_id, status, message, updated_at)
                VALUES (${status.agentId}, ${operationId}, ${status.status},
                    ${status.message ?? null}, ${status.updatedAt})
                ON CONFLICT (agent_id) DO UPDATE SET status = excluded.status,
                    operation_id = excluded.operation_id,
                    message = excluded.message, updated_at = excluded.updated_at`,
        );
    }

    async #findStatusOperation(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<HappyStatusRecord | undefined> {
        const rows = await agentDatabaseRows<StatusRow>(
            ctx.db,
            sql`SELECT agent_id, operation_id, status, message, updated_at
                FROM happy_module_status_operations
                WHERE agent_id = ${agentId} AND operation_id = ${operationId} LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : parseStatus(row);
    }

    async #findStatus(ctx: Context, agentId: string): Promise<HappyStatusRecord | undefined> {
        const rows = await agentDatabaseRows<StatusRow>(
            ctx.db,
            sql`SELECT agent_id, operation_id, status, message, updated_at
                FROM happy_module_status WHERE agent_id = ${agentId} LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : parseStatus(row);
    }

    /**
     * Deliver and publish once the write has committed. The callback is registered against the
     * transaction so a rollback drops it, and it runs on the caller's own context, whose database
     * handle outlives the transaction facade that has just closed.
     */
    #publishAfterCommit(
        callerCtx: Context,
        txCtx: Context,
        event: HappyModuleEvent,
        work: (ctx: Context) => Promise<void>,
    ): void {
        const ownedEvent = ownEvent(event);
        afterCommit(txCtx, async () => {
            try {
                await work(callerCtx);
                await this.#listener?.(callerCtx, ownedEvent);
            } catch (error: unknown) {
                if (this.#onPostCommitError !== undefined) {
                    await this.#onPostCommitError(callerCtx, ownedEvent, error);
                }
            }
        });
    }
}

interface StatusRow {
    agent_id: string;
    operation_id: string;
    status: string;
    message: string | null;
    updated_at: number | string;
}
interface NotificationRow {
    notification_id: string;
    title: string | null;
    body: string;
    level: string;
    created_at: number | string;
}

/**
 * The options as they are checked. Everything the caller passed is checked as given, so a stray
 * field is refused, while the host is checked as the boundary it exposes.
 */
function optionsShape(options: HappyModuleOptions): unknown {
    if (options === null || typeof options !== "object") return options;
    return { ...options, host: happyHostShape(options.host) };
}

function assertAgentId(value: string): void {
    if (!Value.Check(happyAgentIdSchema, value)) throw new Error("Happy agent ID is invalid.");
}

function assertInput<T extends import("@sinclair/typebox").TSchema>(
    schema: T,
    value: unknown,
    label: string,
): asserts value is Static<T> {
    if (!Value.Check(schema, value)) throw new Error(`${label} is invalid.`);
}

function parseStatus(row: StatusRow): HappyStatusRecord {
    const value = {
        agentId: row.agent_id,
        status: row.status,
        updatedAt: Number(row.updated_at),
        ...(row.message === null ? {} : { message: row.message }),
    };
    assertInput(happyStatusRecordSchema, value, "Stored Happy status");
    return structuredClone(value);
}

function parseNotification(row: NotificationRow): HappyNotification {
    const value = {
        body: row.body,
        createdAt: Number(row.created_at),
        id: row.notification_id,
        level: row.level,
        ...(row.title === null ? {} : { title: row.title }),
    };
    assertInput(happyNotificationSchema, value, "Stored Happy notification");
    return structuredClone(value);
}

function sameStatus(left: HappyStatusRecord, right: HappyStatusRecord): boolean {
    return left.status === right.status && left.message === right.message;
}

function formatNotification(value: HappyNotification): string {
    const title = value.title === undefined ? "" : `${value.title}: `;
    return `${title}${value.body}`;
}

function formatStatus(value: HappyStatusRecord): string {
    const message = value.message === undefined ? "" : ` — ${value.message}`;
    return `${value.status}${message}`;
}

function ownEvent<T>(value: T): T {
    return deepFreeze(structuredClone(value)) as T;
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    for (const nested of Object.values(value as Record<string, unknown>)) {
        deepFreeze(nested);
    }
    return Object.freeze(value);
}
