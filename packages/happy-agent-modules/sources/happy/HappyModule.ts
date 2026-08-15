import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    defineAgentTool,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

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
import { assertHappyHost, happyHostSchema, type HappyHost } from "./HappyHost.js";

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

    constructor(options: HappyModuleOptions) {
        const checked = materializeOptions(options);
        if (!Value.Check(happyModuleOptionsSchema, checked)) {
            throw new Error("Happy module options are invalid.");
        }
        assertHappyHost(checked.host);
        this.#host = checked.host;
        this.#clock = checked.clock ?? Date.now;
        this.#idFactory = checked.idFactory ?? (() => `happy-${randomUUID()}`);
        this.#eventIdFactory = checked.eventIdFactory ?? (() => `happy-event-${randomUUID()}`);
        this.#listener = checked.listener;
        this.#onPostCommitError = checked.onPostCommitError;
    }

    async notify(ctx: Context, agentId: string, input: HappyNotificationInput): Promise<HappyNotification> {
        assertAgentId(agentId);
        assertInput(happyNotificationInputSchema, input, "Happy notification input");
        return await ctx.inTx(async (txCtx) => {
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
                        ${notification.title ?? null}, ${notification.body}, ${notification.level},
                        ${notification.createdAt})`,
            );
            const event: HappyModuleEvent = {
                type: "happy_notification_created",
                at: notification.createdAt,
                eventId: this.#eventIdFactory(),
                notification,
            };
            await this.#publishAfterCommit(txCtx, event, async (postCommitCtx) => {
                const delivery = await this.#host.notify(postCommitCtx, agentId, notification);
                assertInput(happyDeliveryResultSchema, delivery, "Happy delivery result");
            });
            return notification;
        });
    }

    async setStatus(ctx: Context, agentId: string, input: HappyStatusInput): Promise<HappyStatusRecord> {
        assertAgentId(agentId);
        assertInput(happyStatusInputSchema, input, "Happy status input");
        return await ctx.inTx(async (txCtx) => {
            const previous = await this.#findStatus(txCtx, agentId);
            const current: HappyStatusRecord = {
                agentId,
                status: input.status,
                updatedAt: this.#clock(),
                ...(input.message === undefined ? {} : { message: input.message }),
            };
            const result =
                previous !== undefined && sameStatus(previous, current) ? previous : current;
            if (result === current) {
                await agentDatabaseRun(
                    txCtx.db,
                    sql`INSERT INTO happy_module_status
                        (agent_id, operation_id, status, message, updated_at)
                        VALUES (${agentId}, ${this.#idFactory()}, ${current.status},
                            ${current.message ?? null}, ${current.updatedAt})
                        ON CONFLICT (agent_id) DO UPDATE SET status = excluded.status,
                            operation_id = excluded.operation_id,
                            message = excluded.message, updated_at = excluded.updated_at`,
                );
                const event: HappyModuleEvent = {
                    type: "happy_status_changed",
                    at: current.updatedAt,
                    eventId: this.#eventIdFactory(),
                    ...(previous === undefined ? {} : { previous }),
                    current,
                };
                await this.#publishAfterCommit(txCtx, event, async (postCommitCtx) => {
                    const delivery = await this.#host.setStatus(postCommitCtx, agentId, current);
                    assertInput(happyDeliveryResultSchema, delivery, "Happy delivery result");
                });
            }
            return result;
        });
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

    readonly instructions = (): string =>
        "Happy is the connected client. Use notify_happy for an explicit user-visible notification and set_happy_status to keep the client status current. Keep notifications concise and never include secrets.";

    readonly tools = (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
        defineAgentTool({
            name: "notify_happy",
            description: "Send a concise user-visible notification to the connected Happy client.",
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
            description: "Set the short status shown for this agent in the connected Happy client.",
            parameters: happyStatusToolInputSchema,
            returnType: happyStatusRecordSchema,
            durable: true,
            transactional: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                await this.setStatus(ctx, scope.agent.id, input),
            toLLM: (result) => [{ type: "text", text: formatStatus(result) }],
        }),
        defineAgentTool({
            name: "get_happy_status",
            description: "Read the status currently shown for this agent in Happy.",
            parameters: Type.Object({}, exact),
            returnType: Type.Union([happyStatusRecordSchema, Type.Null()]),
            shouldReviewInAutoMode: () => false,
            execute: async (ctx) => (await this.getStatus(ctx, scope.agent.id)) ?? null,
            toLLM: (result) => [{ type: "text", text: result === null ? "No Happy status." : formatStatus(result) }],
        }),
    ];

    async #findStatus(
        ctx: Context,
        agentId: string,
    ): Promise<HappyStatusRecord | undefined> {
        const rows = await agentDatabaseRows<StatusRow>(
            ctx.db,
            sql`SELECT agent_id, operation_id, status, message, updated_at
                FROM happy_module_status WHERE agent_id = ${agentId} LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : parseStatus(row);
    }

    async #publishAfterCommit(
        ctx: Context,
        event: HappyModuleEvent,
        work: (ctx: Context) => Promise<void>,
    ): Promise<void> {
        const ownedEvent = ownEvent(event);
        const callback = async (postCommitCtx: Context) => {
            try {
                await work(postCommitCtx);
                await this.#listener?.(postCommitCtx, ownedEvent);
            } catch (error: unknown) {
                if (this.#onPostCommitError !== undefined) {
                    await this.#onPostCommitError(postCommitCtx, ownedEvent, error);
                }
            }
        };
        afterCommit(ctx, callback);
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

function materializeOptions(options: HappyModuleOptions): HappyModuleOptions {
    return {
        ...options,
        host: { notify: options.host.notify, setStatus: options.host.setStatus },
    };
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