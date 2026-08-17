import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    HappyModule,
    assertHappyHost,
    happyModuleEventSchema,
    happyNotificationSchema,
    happyStatusRecordSchema,
    type HappyModuleEvent,
    type HappyHost,
} from "../../sources/happy/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("happy-module-test");

interface Delivery {
    readonly kind: "notify" | "status";
    readonly agentId: string;
    readonly value: unknown;
}

interface HappyHarness {
    readonly module: HappyModule;
    readonly database: ReturnType<typeof moduleDatabase>;
    readonly deliveries: Delivery[];
    readonly events: unknown[];
    readonly postCommitErrors: unknown[];
}

function host(deliveries: Delivery[] = []): HappyHost {
    return {
        notify: async (_ctx, agentId, notification) => {
            deliveries.push({ kind: "notify", agentId, value: structuredClone(notification) });
            return { accepted: true };
        },
        setStatus: async (_ctx, agentId, status) => {
            deliveries.push({ kind: "status", agentId, value: structuredClone(status) });
            return { accepted: true };
        },
    };
}

function harness(
    options: {
        readonly host?: HappyHost;
        readonly clock?: () => number;
        readonly idFactory?: () => string;
        readonly eventIdFactory?: () => string;
        readonly listener?: (ctx: Context, event: HappyModuleEvent) => void | Promise<void>;
        readonly onPostCommitError?: (
            ctx: Context,
            event: HappyModuleEvent,
            error: unknown,
        ) => void | Promise<void>;
        readonly name?: string;
    } = {},
): HappyHarness {
    const deliveries: Delivery[] = [];
    const events: unknown[] = [];
    const postCommitErrors: unknown[] = [];
    const module = new HappyModule({
        host: options.host ?? host(deliveries),
        clock: options.clock ?? (() => 100),
        idFactory: options.idFactory ?? (() => `notification-${deliveries.length + 1}`),
        eventIdFactory:
            options.eventIdFactory ??
            (() => `event-${events.length + postCommitErrors.length + deliveries.length + 1}`),
        listener:
            options.listener ??
            (async (_ctx, event) => {
                events.push(event);
            }),
        onPostCommitError:
            options.onPostCommitError ??
            (async (_ctx, event, error) => {
                postCommitErrors.push({ event, error });
            }),
    });
    return {
        module,
        database: moduleDatabase(module.migrations ?? [], options.name ?? "happy-test"),
        deliveries,
        events,
        postCommitErrors,
    };
}

describe("HappyModule", () => {
    it("owns the stable module name, migration, and client-facing tools", async () => {
        const module = new HappyModule({ host: host() });
        expect(module.name).toBe("happy");
        expect(module.migrations?.map(([key]) => key)).toEqual(["001-happy-state"]);
        const hooks = await resolveModuleHooks(ctx, module);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        expect(tools.map((tool) => tool.name)).toEqual([
            "notify_happy",
            "set_happy_status",
            "get_happy_status",
        ]);
        expect(tools.map((tool) => tool.transactional ?? false)).toEqual([true, true, false]);
    });

    it("rejects a host that does not expose the complete transport boundary", () => {
        expect(
            () =>
                new HappyModule({
                    host: { notify: async () => ({ accepted: true }) } as never,
                }),
        ).toThrow("Happy module options are invalid");
    });

    it("rejects malformed and extra host boundary fields", () => {
        const valid = {
            notify: async () => ({ accepted: true }),
            setStatus: async () => ({ accepted: true }),
        };

        expect(() => assertHappyHost({ ...valid, extra: true })).toThrow(
            "Happy module host is invalid",
        );
        expect(() =>
            assertHappyHost({ notify: "not-a-function", setStatus: valid.setStatus }),
        ).toThrow("Happy module host is invalid");
        expect(() => assertHappyHost(null)).toThrow("Happy module host is invalid");
        expect(
            () =>
                new HappyModule({
                    host: valid,
                    extra: true,
                } as never),
        ).toThrow("Happy module options are invalid");
    });

    it("rejects extra fields supplied by a host adapter at construction", () => {
        expect(
            () =>
                new HappyModule({
                    host: {
                        notify: async () => ({ accepted: true }),
                        setStatus: async () => ({ accepted: true }),
                        extra: true,
                    },
                } as never),
        ).toThrow("Happy module options are invalid");
    });

    it("persists notifications and status across a fresh module instance", async () => {
        let now = 100;
        let nextId = 0;
        let nextEventId = 0;
        const deliveries: Delivery[] = [];
        const events: unknown[] = [];
        const first = harness({
            name: "happy-reload-test",
            host: host(deliveries),
            clock: () => now,
            idFactory: () => `operation-${++nextId}`,
            eventIdFactory: () => `event-${++nextEventId}`,
            listener: (_ctx, event) => {
                events.push(structuredClone(event));
            },
        });
        await first.database.ready;

        try {
            const notification = await first.module.notify(first.database.context, "agent-a", {
                title: "Build",
                body: "Finished",
                level: "success",
            });
            expect(notification).toEqual({
                id: "operation-1",
                title: "Build",
                body: "Finished",
                level: "success",
                createdAt: 100,
            });

            now = 200;
            const status = await first.module.setStatus(first.database.context, "agent-a", {
                status: "working",
                message: "Building",
            });
            expect(status).toEqual({
                agentId: "agent-a",
                status: "working",
                message: "Building",
                updatedAt: 200,
            });
            expect(deliveries).toEqual([
                { kind: "notify", agentId: "agent-a", value: notification },
                { kind: "status", agentId: "agent-a", value: status },
            ]);
            expect(events).toHaveLength(2);
            expect(Value.Check(happyNotificationSchema, notification)).toBe(true);
            expect(Value.Check(happyStatusRecordSchema, status)).toBe(true);
            expect(Value.Check(happyModuleEventSchema, events[0])).toBe(true);
            expect(Value.Check(happyModuleEventSchema, events[1])).toBe(true);

            const reloadedDeliveries: Delivery[] = [];
            const reloaded = new HappyModule({
                host: host(reloadedDeliveries),
                clock: () => 300,
                idFactory: () => "operation-reloaded",
                eventIdFactory: () => "event-reloaded",
            });
            expect(await reloaded.getStatus(first.database.context, "agent-a")).toEqual(status);
            expect(await reloaded.listNotifications(first.database.context, "agent-a")).toEqual([
                notification,
            ]);
            expect(await reloaded.getStatus(first.database.context, "agent-b")).toBeUndefined();
            expect(await reloaded.listNotifications(first.database.context, "agent-b")).toEqual([]);
            expect(reloadedDeliveries).toEqual([]);
        } finally {
            first.database.close();
        }
    });

    it("preserves the receiver of class-backed host adapters", async () => {
        class Adapter {
            readonly notifications: string[] = [];

            async notify(
                _ctx: Context,
                _agentId: string,
                notification: import("../../sources/happy/index.js").HappyNotification,
            ) {
                this.notifications.push(notification.body);
                return { accepted: true };
            }

            async setStatus(
                _ctx: Context,
                _agentId: string,
                _status: import("../../sources/happy/index.js").HappyStatusRecord,
            ) {
                return { accepted: true };
            }
        }

        const adapter = new Adapter();
        const test = harness({
            name: "happy-class-host-test",
            host: adapter as unknown as HappyHost,
        });
        await test.database.ready;

        try {
            await test.module.notify(test.database.context, "agent-a", { body: "delivered" });
            expect(adapter.notifications).toEqual(["delivered"]);
        } finally {
            test.database.close();
        }
    });

    it("does not allow a host adapter to mutate a returned notification", async () => {
        const test = harness({
            name: "happy-host-mutation-test",
            host: {
                notify: async (_ctx, _agentId, notification) => {
                    notification.body = "host-mutated";
                    return { accepted: true };
                },
                setStatus: async () => ({ accepted: true }),
            },
        });
        await test.database.ready;

        try {
            const result = await test.module.notify(test.database.context, "agent-a", {
                body: "caller-value",
            });
            expect(result.body).toBe("caller-value");
            expect(await test.module.listNotifications(test.database.context, "agent-a")).toEqual([
                expect.objectContaining({ body: "caller-value" }),
            ]);
        } finally {
            test.database.close();
        }
    });

    it("does not allow a host adapter to mutate a returned status", async () => {
        const test = harness({
            name: "happy-status-host-mutation-test",
            host: {
                notify: async () => ({ accepted: true }),
                setStatus: async (_ctx, _agentId, status) => {
                    status.message = "host-mutated";
                    return { accepted: true };
                },
            },
        });
        await test.database.ready;

        try {
            const result = await test.module.setStatus(test.database.context, "agent-a", {
                status: "working",
                message: "caller-value",
            });
            expect(result.message).toBe("caller-value");
            expect(await test.module.getStatus(test.database.context, "agent-a")).toEqual(result);
        } finally {
            test.database.close();
        }
    });

    it("does not deliver or publish a status no-op", async () => {
        let now = 100;
        const test = harness({ name: "happy-status-noop-test", clock: () => now });
        await test.database.ready;

        try {
            const first = await test.module.setStatus(test.database.context, "agent-a", {
                status: "working",
                message: "same",
            });
            now = 200;
            const same = await test.module.setStatus(test.database.context, "agent-a", {
                status: "working",
                message: "same",
            });
            expect(same).toEqual(first);
            expect(test.deliveries).toHaveLength(1);
            expect(test.events).toHaveLength(1);

            now = 300;
            const changed = await test.module.setStatus(test.database.context, "agent-a", {
                status: "working",
                message: "different",
            });
            expect(changed.updatedAt).toBe(300);
            expect(test.deliveries).toHaveLength(2);
            expect(test.events).toHaveLength(2);
            expect(test.events[1]).toMatchObject({
                type: "happy_status_changed",
                previous: first,
                current: changed,
            });
        } finally {
            test.database.close();
        }
    });

    it("enforces notification and status bounds at the public boundary", async () => {
        const test = harness({ name: "happy-bounds-test" });
        await test.database.ready;

        try {
            const maxAgentId = "a".repeat(256);
            const maxNotification = await test.module.notify(test.database.context, maxAgentId, {
                body: "b".repeat(8_000),
                title: "t".repeat(160),
            });
            expect(maxNotification.body).toHaveLength(8_000);
            expect(maxNotification.title).toHaveLength(160);

            const maxStatus = await test.module.setStatus(test.database.context, maxAgentId, {
                status: "waiting",
                message: "m".repeat(1_000),
            });
            expect(maxStatus.message).toHaveLength(1_000);

            await expect(
                test.module.notify(test.database.context, "agent-a", { body: "" }),
            ).rejects.toThrow("Happy notification input is invalid");
            await expect(
                test.module.notify(test.database.context, "agent-a", {
                    body: "b".repeat(8_001),
                }),
            ).rejects.toThrow("Happy notification input is invalid");
            await expect(
                test.module.notify(test.database.context, "agent-a", {
                    body: "body",
                    title: "t".repeat(161),
                }),
            ).rejects.toThrow("Happy notification input is invalid");
            await expect(
                test.module.notify(test.database.context, "agent-a", {
                    body: "body",
                    level: "fatal",
                } as never),
            ).rejects.toThrow("Happy notification input is invalid");
            await expect(
                test.module.notify(test.database.context, "agent-a", {
                    body: "body",
                    extra: true,
                } as never),
            ).rejects.toThrow("Happy notification input is invalid");
            await expect(
                test.module.setStatus(test.database.context, "agent-a", {
                    status: "working",
                    message: "m".repeat(1_001),
                }),
            ).rejects.toThrow("Happy status input is invalid");
            await expect(
                test.module.setStatus(test.database.context, "agent-a", {
                    status: "running",
                } as never),
            ).rejects.toThrow("Happy status input is invalid");
            await expect(
                test.module.setStatus(test.database.context, "agent-a", {
                    status: "working",
                    extra: true,
                } as never),
            ).rejects.toThrow("Happy status input is invalid");
            await expect(
                test.module.notify(test.database.context, `bad\nagent`, { body: "body" }),
            ).rejects.toThrow("Happy agent ID is invalid");
            await expect(
                test.module.notify(test.database.context, `bad\ragent`, { body: "body" }),
            ).rejects.toThrow("Happy agent ID is invalid");
            await expect(
                test.module.notify(test.database.context, `bad\u0000agent`, { body: "body" }),
            ).rejects.toThrow("Happy agent ID is invalid");
            await expect(
                test.module.notify(test.database.context, "a".repeat(257), { body: "body" }),
            ).rejects.toThrow("Happy agent ID is invalid");
        } finally {
            test.database.close();
        }
    });

    it("validates list limits and keeps reads bounded and isolated", async () => {
        let now = 1;
        let nextId = 0;
        const test = harness({
            name: "happy-list-test",
            clock: () => now++,
            idFactory: () => `notification-${++nextId}`,
        });
        await test.database.ready;

        try {
            await test.module.notify(test.database.context, "agent-a", { body: "first" });
            await test.module.notify(test.database.context, "agent-a", { body: "second" });
            await test.module.notify(test.database.context, "agent-a", { body: "third" });
            await test.module.notify(test.database.context, "agent-b", { body: "other" });

            expect(
                await test.module.listNotifications(test.database.context, "agent-a", 2),
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ body: "second" }),
                    expect.objectContaining({ body: "third" }),
                ]),
            );
            expect(await test.module.listNotifications(test.database.context, "agent-b")).toEqual([
                expect.objectContaining({ body: "other" }),
            ]);
            expect(await test.module.listNotifications(test.database.context, "agent-c")).toEqual(
                [],
            );
            for (const limit of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
                await expect(
                    test.module.listNotifications(test.database.context, "agent-a", limit),
                ).rejects.toThrow("Happy notification limit is invalid");
            }
        } finally {
            test.database.close();
        }
    });

    it("rejects duplicate notification identities without a second delivery", async () => {
        const test = harness({
            name: "happy-duplicate-notification-test",
            idFactory: () => "duplicate-notification",
        });
        await test.database.ready;

        try {
            await test.module.notify(test.database.context, "agent-a", { body: "first" });
            await expect(
                test.module.notify(test.database.context, "agent-a", { body: "second" }),
            ).rejects.toThrow();
            expect(test.deliveries).toHaveLength(1);
            expect(await test.module.listNotifications(test.database.context, "agent-a")).toEqual([
                expect.objectContaining({ body: "first" }),
            ]);
        } finally {
            test.database.close();
        }
    });

    it("drops all durable and post-commit effects when an outer transaction rolls back", async () => {
        const test = harness({ name: "happy-rollback-test" });
        await test.database.ready;

        try {
            await expect(
                test.database.context.inTx(async (txCtx) => {
                    await test.module.notify(txCtx, "agent-a", { body: "should roll back" });
                    await test.module.setStatus(txCtx, "agent-a", {
                        status: "working",
                        message: "should roll back",
                    });
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");

            expect(test.deliveries).toEqual([]);
            expect(test.events).toEqual([]);
            expect(test.postCommitErrors).toEqual([]);
            expect(await test.module.getStatus(test.database.context, "agent-a")).toBeUndefined();
            expect(await test.module.listNotifications(test.database.context, "agent-a")).toEqual(
                [],
            );
        } finally {
            test.database.close();
        }
    });

    it("delivers only after commit and gives the host committed database state", async () => {
        const committedRows: number[] = [];
        const test = harness({
            name: "happy-after-commit-test",
            host: {
                notify: async (postCommitCtx, agentId, notification) => {
                    const rows = await agentDatabaseRows<{ count: number }>(
                        postCommitCtx.db,
                        sql`SELECT COUNT(*) AS count
                            FROM happy_module_notifications
                            WHERE agent_id = ${agentId}`,
                    );
                    committedRows.push(Number(rows[0]?.count ?? 0));
                    expect(notification.body).toBe("committed");
                    return { accepted: true };
                },
                setStatus: async () => ({ accepted: true }),
            },
        });
        await test.database.ready;

        try {
            await test.module.notify(test.database.context, "agent-a", { body: "committed" });
            expect(committedRows).toEqual([1]);
        } finally {
            test.database.close();
        }
    });

    it("contains malformed delivery results and host failures after durable commit", async () => {
        const errors: unknown[] = [];
        const invalidDelivery = harness({
            name: "happy-invalid-delivery-test",
            host: {
                notify: async () => ({ accepted: "yes" }) as never,
                setStatus: async () => ({ accepted: true }),
            },
            onPostCommitError: (_ctx, _event, error) => {
                errors.push(error);
            },
        });
        await invalidDelivery.database.ready;

        try {
            const result = await invalidDelivery.module.notify(
                invalidDelivery.database.context,
                "agent-a",
                { body: "saved" },
            );
            expect(result.body).toBe("saved");
            expect(errors).toHaveLength(1);
            expect(
                await invalidDelivery.module.listNotifications(
                    invalidDelivery.database.context,
                    "agent-a",
                ),
            ).toHaveLength(1);
        } finally {
            invalidDelivery.database.close();
        }

        const thrown = harness({
            name: "happy-host-failure-test",
            host: {
                notify: async () => {
                    throw new Error("transport offline");
                },
                setStatus: async () => ({ accepted: true }),
            },
            onPostCommitError: (_ctx, _event, error) => {
                errors.push(error);
            },
        });
        await thrown.database.ready;
        try {
            await expect(
                thrown.module.notify(thrown.database.context, "agent-a", { body: "saved" }),
            ).resolves.toMatchObject({ body: "saved" });
            expect(errors).toHaveLength(2);
            expect(
                await thrown.module.listNotifications(thrown.database.context, "agent-a"),
            ).toHaveLength(1);
        } finally {
            thrown.database.close();
        }
    });

    it("contains listener and error-reporter failures without undoing durable state", async () => {
        const listenerErrors: unknown[] = [];
        const test = harness({
            name: "happy-listener-failure-test",
            listener: () => {
                throw new Error("observer failed");
            },
            onPostCommitError: (_ctx, _event, error) => {
                listenerErrors.push(error);
                throw new Error("reporter failed");
            },
        });
        await test.database.ready;

        try {
            await expect(
                test.module.setStatus(test.database.context, "agent-a", {
                    status: "done",
                }),
            ).resolves.toMatchObject({ status: "done" });
            expect(listenerErrors).toHaveLength(1);
            expect(await test.module.getStatus(test.database.context, "agent-a")).toMatchObject({
                status: "done",
            });
        } finally {
            test.database.close();
        }
    });

    it("deep-freezes event snapshots before exposing them to listeners", async () => {
        let seen: HappyModuleEvent | undefined;
        const test = harness({
            name: "happy-event-freeze-test",
            listener: (_ctx, event) => {
                seen = event;
            },
        });
        await test.database.ready;

        try {
            await test.module.notify(test.database.context, "agent-a", {
                title: "Title",
                body: "Body",
            });
            expect(Object.isFrozen(seen)).toBe(true);
            if (seen === undefined || seen.type !== "happy_notification_created") {
                throw new Error("Expected a notification event.");
            }
            expect(Object.isFrozen(seen.notification)).toBe(true);
            expect(Object.isFrozen(seen.notification.body)).toBe(true);
        } finally {
            test.database.close();
        }
    });

    it("rejects malformed factory output and leaves no partial state", async () => {
        const badClock = harness({
            name: "happy-bad-clock-test",
            clock: () => -1,
        });
        await badClock.database.ready;
        try {
            await expect(
                badClock.module.notify(badClock.database.context, "agent-a", { body: "body" }),
            ).rejects.toThrow("Happy notification is invalid");
            expect(
                await badClock.module.listNotifications(badClock.database.context, "agent-a"),
            ).toEqual([]);
        } finally {
            badClock.database.close();
        }

        const badId = harness({
            name: "happy-bad-id-test",
            idFactory: () => "",
        });
        await badId.database.ready;
        try {
            await expect(
                badId.module.notify(badId.database.context, "agent-a", { body: "body" }),
            ).rejects.toThrow("Happy notification is invalid");
            expect(await badId.module.listNotifications(badId.database.context, "agent-a")).toEqual(
                [],
            );
        } finally {
            badId.database.close();
        }
    });

    it("rejects an invalid event identity instead of publishing an invalid event", async () => {
        const test = harness({
            name: "happy-bad-event-test",
            eventIdFactory: () => "",
        });
        await test.database.ready;

        try {
            await expect(
                test.module.notify(test.database.context, "agent-a", { body: "body" }),
            ).rejects.toThrow("Happy event is invalid");
            expect(test.deliveries).toEqual([]);
            expect(test.events).toEqual([]);
            expect(await test.module.listNotifications(test.database.context, "agent-a")).toEqual(
                [],
            );
        } finally {
            test.database.close();
        }
    });

    it("rejects malformed persisted status and notification rows", async () => {
        const test = harness({ name: "happy-corrupt-state-test" });
        await test.database.ready;

        try {
            await test.module.setStatus(test.database.context, "agent-a", { status: "working" });
            await agentDatabaseRun(
                test.database.database,
                sql`UPDATE happy_module_status SET status = 'corrupt'
                    WHERE agent_id = ${"agent-a"}`,
            );
            await expect(test.module.getStatus(test.database.context, "agent-a")).rejects.toThrow(
                "Stored Happy status is invalid",
            );

            await test.module.notify(test.database.context, "agent-a", { body: "body" });
            await agentDatabaseRun(
                test.database.database,
                sql`UPDATE happy_module_notifications SET level = 'corrupt'
                    WHERE agent_id = ${"agent-a"}`,
            );
            await expect(
                test.module.listNotifications(test.database.context, "agent-a"),
            ).rejects.toThrow("Stored Happy notification is invalid");
        } finally {
            test.database.close();
        }
    });

    it("uses the same public operations through all model-facing tools", async () => {
        const test = harness({ name: "happy-tools-test" });
        await test.database.ready;

        try {
            const hooks = await resolveModuleHooks(test.database.context, test.module);
            const tools = await hooks.tools!(test.database.context, {
                agent: { id: "agent-tool", permissionMode: "auto" },
            } as never);
            const notify = tools.find((tool) => tool.name === "notify_happy");
            const setStatus = tools.find((tool) => tool.name === "set_happy_status");
            const getStatus = tools.find((tool) => tool.name === "get_happy_status");
            if (notify === undefined || setStatus === undefined || getStatus === undefined) {
                throw new Error("Happy tools are incomplete.");
            }

            expect(notify.durable).toBe(false);
            expect(notify.transactional).toBe(true);
            expect(setStatus.durable).toBe(true);
            expect(setStatus.transactional).toBe(true);
            expect(getStatus.transactional ?? false).toBe(false);
            expect(
                await notify.shouldReviewInAutoMode({ body: "body" }, test.database.context),
            ).toBe(false);
            expect(Value.Check(notify.parameters, { body: "body" })).toBe(true);
            expect(Value.Check(notify.parameters, { body: "body", operationId: "leak" })).toBe(
                false,
            );

            const call = { id: "tool-call", providerCallId: "provider-call" } as never;
            const notification = await notify.execute(
                test.database.context,
                { title: "Title", body: "Body" },
                call,
            );
            expect(Value.Check(notify.returnType, notification)).toBe(true);
            expect(notify.toLLM(notification)).toEqual([{ type: "text", text: "Title: Body" }]);

            const status = await setStatus.execute(
                test.database.context,
                { status: "working", message: "Building" },
                call,
            );
            expect(Value.Check(setStatus.returnType, status)).toBe(true);
            expect(setStatus.toLLM(status)).toEqual([{ type: "text", text: "working — Building" }]);

            const read = await getStatus.execute(test.database.context, {}, call);
            expect(read).toEqual(status);
            expect(getStatus.toLLM(null)).toEqual([{ type: "text", text: "No Happy status." }]);
        } finally {
            test.database.close();
        }
    });

    it("replays a durable status tool call without reapplying it after intervening state", async () => {
        const test = harness({ name: "happy-tool-replay-test" });
        await test.database.ready;

        try {
            const hooks = await resolveModuleHooks(test.database.context, test.module);
            const tools = await hooks.tools!(test.database.context, {
                agent: { id: "agent-replay", permissionMode: "auto" },
            } as never);
            const setStatus = tools.find((tool) => tool.name === "set_happy_status");
            if (setStatus === undefined) throw new Error("Happy status tool is missing.");

            const call = { id: "stable-call", providerCallId: "provider-call" } as never;
            const first = await setStatus.execute(
                test.database.context,
                { status: "working", message: "first" },
                call,
            );
            await test.module.setStatus(test.database.context, "agent-replay", {
                status: "idle",
            });
            const replay = await setStatus.execute(
                test.database.context,
                { status: "working", message: "first" },
                call,
            );

            expect(replay).toEqual(first);
            expect(await test.module.getStatus(test.database.context, "agent-replay")).toEqual(
                first,
            );
            expect(test.deliveries).toHaveLength(2);
        } finally {
            test.database.close();
        }
    });

    it("keeps concurrent notification mutations distinct and durable", async () => {
        let nextId = 0;
        const test = harness({
            name: "happy-concurrency-test",
            idFactory: () => `notification-${++nextId}`,
        });
        await test.database.ready;

        try {
            const results = await Promise.all(
                Array.from({ length: 8 }, (_, index) =>
                    test.module.notify(test.database.context, "agent-a", {
                        body: `body-${index}`,
                    }),
                ),
            );
            expect(new Set(results.map((result) => result.id)).size).toBe(8);
            expect(
                await test.module.listNotifications(test.database.context, "agent-a", 100),
            ).toHaveLength(8);
            expect(test.deliveries).toHaveLength(8);
            expect(test.events).toHaveLength(8);
        } finally {
            test.database.close();
        }
    });

    it("requires an Agent Base database context for public reads and writes", async () => {
        const test = new HappyModule({ host: host() });
        const bare = createRootContext().named("happy-no-database");
        await expect(test.getStatus(bare, "agent-a")).rejects.toThrow(
            "Context has no agent database",
        );
        await expect(test.listNotifications(bare, "agent-a")).rejects.toThrow(
            "Context has no agent database",
        );
        await expect(test.notify(bare, "agent-a", { body: "body" })).rejects.toThrow(
            "Context has no agent database",
        );
    });
});
