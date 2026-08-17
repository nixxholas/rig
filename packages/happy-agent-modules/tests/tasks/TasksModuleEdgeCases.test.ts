import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    MAX_TASK_METADATA_BYTES,
    MAX_TASK_METADATA_DEPTH,
    MAX_TASK_METADATA_ITEMS,
    MAX_TASK_METADATA_KEYS,
    MAX_TASK_METADATA_STRING_LENGTH,
    TaskValidationError,
} from "../../sources/tasks/Task.js";
import { TasksModule, MAX_TASKS } from "../../sources/tasks/TasksModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

function seedTasks(
    database: ReturnType<typeof moduleDatabase>,
    agentId: string,
    tasksJson: string,
): Promise<void> {
    return agentDatabaseRun(
        database.database,
        sql`INSERT INTO happy_agent_task_state (agent_id, tasks_json)
            VALUES (${agentId}, ${tasksJson})
            ON CONFLICT (agent_id) DO UPDATE SET tasks_json = EXCLUDED.tasks_json`,
    );
}

function baseTask(overrides: Record<string, unknown> = {}) {
    return {
        id: "task-a",
        title: "Task A",
        status: "pending",
        priority: "normal",
        dependsOn: [],
        blocks: [],
        createdAt: 1,
        updatedAt: 1,
        ordering: 0,
        ...overrides,
    };
}

describe("TasksModule edge cases", () => {
    it("validates constructor options and factory outputs at their boundaries", async () => {
        expect(() => new TasksModule({ maxTasks: 0 })).toThrow();
        expect(() => new TasksModule({ maxTasks: MAX_TASKS + 1 })).toThrow();
        expect(() => new TasksModule({ defaultPriority: "urgent" as never })).toThrow();
        expect(() => new TasksModule({ maxOutputCharacters: 255 })).toThrow();
        expect(() => new TasksModule({ maxOutputCharacters: 100_001 })).toThrow();
        expect(() => new TasksModule({ maxPageSize: 0 })).toThrow();
        expect(() => new TasksModule({ maxPageSize: 101 })).toThrow();
        expect(() => new TasksModule({ unknown: true } as never)).toThrow();

        const cases = [
            [new TasksModule({ idFactory: () => "" }), "Task ID is invalid"],
            [new TasksModule({ clock: () => -1 }), "clock"],
            [new TasksModule({ eventIdFactory: () => "" }), "event ID"],
        ] as const;
        for (const [tasks, message] of cases) {
            const database = moduleDatabase(tasks.migrations, `tasks-invalid-factory-${message}`);
            await database.ready;
            try {
                await expect(
                    tasks.create(database.context, "agent-a", { title: "task" }),
                ).rejects.toThrow(message);
                await expect(tasks.list(database.context, "agent-a")).resolves.toEqual([]);
            } finally {
                database.close();
            }
        }
    });

    it("normalizes bounded scalar fields and clears optional values explicitly", async () => {
        let now = 10;
        const tasks = new TasksModule({
            clock: () => now++,
            idFactory: () => "generated",
            eventIdFactory: () => `event-${now}`,
        });
        const database = moduleDatabase(tasks.migrations, "tasks-normalization-test");
        await database.ready;
        try {
            const created = await tasks.create(database.context, "agent-a", {
                title: "  Ship it  ",
                detail: "  some detail  ",
                activeForm: "  Shipping it  ",
                owner: "  worker  ",
            });
            expect(created).toMatchObject({
                id: "generated",
                title: "Ship it",
                detail: "some detail",
                activeForm: "Shipping it",
                owner: "worker",
                createdAt: 10,
                updatedAt: 10,
            });
            const cleared = await tasks.update(database.context, "agent-a", created.id, {
                detail: null,
                activeForm: null,
                owner: null,
            });
            expect(cleared).not.toHaveProperty("detail");
            expect(cleared).not.toHaveProperty("activeForm");
            expect(cleared).not.toHaveProperty("owner");

            const emptyDetail = await tasks.update(database.context, "agent-a", created.id, {
                detail: "   ",
            });
            expect(emptyDetail).not.toHaveProperty("detail");
        } finally {
            database.close();
        }
    });

    it("rejects invalid scalar values, IDs, and dependency mutations without partial writes", async () => {
        const events: unknown[] = [];
        const tasks = new TasksModule({
            listener: { onEvent: (_ctx, event) => events.push(event) },
            idFactory: () => "generated",
            eventIdFactory: () => `event-${events.length + 1}`,
            clock: () => 10,
        });
        const database = moduleDatabase(tasks.migrations, "tasks-invalid-input-test");
        await database.ready;
        try {
            for (const input of [
                { title: "   " },
                { title: "ok", activeForm: "   " },
                { title: "ok", owner: "   " },
                { title: "ok", detail: "x".repeat(4_001) },
                { title: "ok", id: "" },
                { title: "ok", id: "x".repeat(129) },
            ]) {
                await expect(
                    tasks.create(database.context, "agent-a", input as never),
                ).rejects.toThrow();
            }
            await expect(
                tasks.create(database.context, "agent-a", { title: "ok", dependsOn: ["missing"] }),
            ).rejects.toThrow('Task dependency "missing" does not exist.');
            await expect(
                tasks.create(database.context, "agent-a", {
                    id: "self",
                    title: "self",
                    dependsOn: ["self"],
                }),
            ).rejects.toThrow("cannot depend on itself");
            await expect(tasks.list(database.context, "")).rejects.toThrow("agent ID is invalid");
            await expect(tasks.list(database.context, "a".repeat(257))).rejects.toThrow(
                "agent ID is invalid",
            );
            await expect(tasks.get(database.context, "agent-a", "")).rejects.toThrow(
                "Task ID is invalid",
            );
            expect(events).toEqual([]);
            await expect(tasks.list(database.context, "agent-a")).resolves.toEqual([]);
        } finally {
            database.close();
        }
    });

    it("enforces metadata shape, key, item, string, and byte bounds", async () => {
        const tasks = new TasksModule({ idFactory: () => "task", eventIdFactory: () => "event" });
        const database = moduleDatabase(tasks.migrations, "tasks-metadata-bounds-test");
        await database.ready;
        try {
            const tooManyKeys = Object.fromEntries(
                Array.from({ length: MAX_TASK_METADATA_KEYS + 1 }, (_, index) => [
                    `key-${index}`,
                    true,
                ]),
            );
            const tooManyItems = Array.from({ length: MAX_TASK_METADATA_ITEMS + 1 }, () => true);
            const tooLongString = "x".repeat(MAX_TASK_METADATA_STRING_LENGTH + 1);
            const tooLarge = { value: "x".repeat(MAX_TASK_METADATA_BYTES) };
            const metadataCases = [
                tooManyKeys,
                { values: tooManyItems },
                { value: tooLongString },
                tooLarge,
                { value: Number.NaN },
                { value: Number.POSITIVE_INFINITY },
            ];
            for (const [index, metadata] of metadataCases.entries()) {
                await expect(
                    tasks.create(database.context, `agent-${index}`, {
                        id: `task-${index}`,
                        title: "metadata",
                        metadata: metadata as never,
                    }),
                ).rejects.toThrow(TaskValidationError);
            }
            await expect(tasks.list(database.context, "agent-ok")).resolves.toEqual([]);
        } finally {
            database.close();
        }
    });

    it("rejects cyclic metadata with a bounded domain validation error", async () => {
        const tasks = new TasksModule();
        const database = moduleDatabase(tasks.migrations, "tasks-metadata-cycle-test");
        await database.ready;
        try {
            const cyclic: Record<string, unknown> = {};
            cyclic.self = cyclic;
            await expect(
                tasks.create(database.context, "agent-a", {
                    id: "task-a",
                    title: "metadata",
                    metadata: cyclic as never,
                }),
            ).rejects.toThrow(TaskValidationError);
        } finally {
            database.close();
        }
    });

    it("rejects over-deep metadata with a bounded domain validation error", async () => {
        const tasks = new TasksModule();
        const database = moduleDatabase(tasks.migrations, "tasks-metadata-depth-test");
        await database.ready;
        try {
            const deep: Record<string, unknown> = {};
            let cursor = deep;
            for (let index = 0; index <= MAX_TASK_METADATA_DEPTH; index += 1) {
                cursor.next = {};
                cursor = cursor.next as Record<string, unknown>;
            }
            await expect(
                tasks.create(database.context, "agent-a", {
                    id: "task-a",
                    title: "metadata",
                    metadata: deep as never,
                }),
            ).rejects.toThrow(TaskValidationError);
        } finally {
            database.close();
        }
    });

    it("enforces the configured task count and keeps the rejected mutation durable-state free", async () => {
        const events: string[] = [];
        const tasks = new TasksModule({
            maxTasks: 2,
            eventIdFactory: () => `event-${events.length + 1}`,
            listener: { onEvent: (_ctx, event) => events.push(event.type) },
        });
        const database = moduleDatabase(tasks.migrations, "tasks-max-count-test");
        await database.ready;
        try {
            await tasks.create(database.context, "agent-a", { id: "a", title: "A" });
            await tasks.create(database.context, "agent-a", { id: "b", title: "B" });
            await expect(
                tasks.create(database.context, "agent-a", { id: "c", title: "C" }),
            ).rejects.toThrow("maximum of 2");
            expect(await tasks.list(database.context, "agent-a")).toHaveLength(2);
            expect(events).toEqual(["task_created", "task_created"]);
        } finally {
            database.close();
        }
    });

    it("survives a fresh module instance and isolates each agent's task list", async () => {
        const first = new TasksModule({ clock: () => 1, eventIdFactory: () => "first" });
        const database = moduleDatabase(first.migrations, "tasks-restart-isolation-test");
        await database.ready;
        try {
            await first.create(database.context, "agent-a", { id: "a", title: "A" });
            await first.create(database.context, "agent-b", { id: "b", title: "B" });
            const restarted = new TasksModule({ clock: () => 2, eventIdFactory: () => "second" });
            await expect(restarted.list(database.context, "agent-a")).resolves.toMatchObject([
                { id: "a", title: "A" },
            ]);
            await expect(restarted.list(database.context, "agent-b")).resolves.toMatchObject([
                { id: "b", title: "B" },
            ]);
        } finally {
            database.close();
        }
    });

    it("rejects malformed JSON and every stored task-list invariant", async () => {
        const cases = [
            ["invalid-json", "{not-json"],
            ["duplicate-ids", JSON.stringify([baseTask(), baseTask({ ordering: 1 })])],
            ["ordering-gap", JSON.stringify([baseTask({ ordering: 1 })])],
            [
                "reverse-links",
                JSON.stringify([
                    baseTask({ blocks: ["other"] }),
                    baseTask({ id: "other", ordering: 1 }),
                ]),
            ],
            ["missing-dependency", JSON.stringify([baseTask({ dependsOn: ["missing"] })])],
            [
                "cycle",
                JSON.stringify([
                    baseTask({ dependsOn: ["other"], blocks: ["other"] }),
                    baseTask({
                        id: "other",
                        ordering: 1,
                        dependsOn: ["task-a"],
                        blocks: ["task-a"],
                    }),
                ]),
            ],
            ["timestamp-order", JSON.stringify([baseTask({ createdAt: 10, updatedAt: 9 })])],
            ["untrimmed-title", JSON.stringify([baseTask({ title: " Task A" })])],
        ] as const;

        for (const [name, tasksJson] of cases) {
            const tasks = new TasksModule();
            const database = moduleDatabase(tasks.migrations, `tasks-malformed-${name}`);
            await database.ready;
            try {
                await seedTasks(database, "agent-a", tasksJson);
                await expect(tasks.list(database.context, "agent-a")).rejects.toThrow();
            } finally {
                database.close();
            }
        }
    });

    it("supports reorder, exact no-op detection, reset, and contiguous removal ordering", async () => {
        const events: string[] = [];
        let at = 1;
        const tasks = new TasksModule({
            clock: () => at++,
            eventIdFactory: () => `event-${events.length + 1}`,
            listener: { onEvent: (_ctx, event) => events.push(event.type) },
        });
        const database = moduleDatabase(tasks.migrations, "tasks-order-reset-test");
        await database.ready;
        try {
            await tasks.create(database.context, "agent-a", { id: "a", title: "A" });
            await tasks.create(database.context, "agent-a", { id: "b", title: "B" });
            await tasks.create(database.context, "agent-a", { id: "c", title: "C" });
            const reordered = await tasks.reorder(database.context, "agent-a", ["c", "a", "b"]);
            expect(reordered.map((task) => [task.id, task.ordering])).toEqual([
                ["c", 0],
                ["a", 1],
                ["b", 2],
            ]);
            expect(events).toEqual([
                "task_created",
                "task_created",
                "task_created",
                "tasks_reordered",
            ]);
            await tasks.reorder(database.context, "agent-a", ["c", "a", "b"]);
            expect(events).toHaveLength(4);

            await tasks.remove(database.context, "agent-a", "a");
            expect(await tasks.list(database.context, "agent-a")).toMatchObject([
                { id: "c", ordering: 0 },
                { id: "b", ordering: 1 },
            ]);
            await expect(tasks.reorder(database.context, "agent-a", ["c"])).rejects.toThrow(
                "every current task",
            );
            await expect(tasks.reorder(database.context, "agent-a", ["c", "c"])).rejects.toThrow();

            await expect(tasks.reset(database.context, "agent-a")).resolves.toBe(2);
            await expect(tasks.reset(database.context, "agent-a")).resolves.toBe(0);
            expect(events).toEqual([
                "task_created",
                "task_created",
                "task_created",
                "tasks_reordered",
                "task_removed",
                "tasks_reset",
            ]);
        } finally {
            database.close();
        }
    });

    it("keeps dependency graph operations acyclic and bidirectional under incremental changes", async () => {
        const tasks = new TasksModule({ clock: () => 1, eventIdFactory: () => "event" });
        const database = moduleDatabase(tasks.migrations, "tasks-dependency-graph-test");
        await database.ready;
        try {
            await tasks.create(database.context, "agent-a", { id: "a", title: "A" });
            await tasks.create(database.context, "agent-a", { id: "b", title: "B" });
            await tasks.create(database.context, "agent-a", { id: "c", title: "C" });
            await tasks.update(database.context, "agent-a", "b", { addBlockedBy: ["a"] });
            await tasks.update(database.context, "agent-a", "c", { addBlockedBy: ["b"] });
            await expect(
                tasks.update(database.context, "agent-a", "a", { addBlockedBy: ["c"] }),
            ).rejects.toThrow("cycle");
            await expect(
                tasks.update(database.context, "agent-a", "a", { addBlocks: ["a"] }),
            ).rejects.toThrow("cannot depend on itself");
            await tasks.update(database.context, "agent-a", "b", { removeBlockedBy: ["a"] });
            expect(await tasks.get(database.context, "agent-a", "a")).toMatchObject({ blocks: [] });
            expect(await tasks.get(database.context, "agent-a", "b")).toMatchObject({
                dependsOn: [],
            });
            await tasks.update(database.context, "agent-a", "a", { addBlocks: ["b"] });
            expect(await tasks.get(database.context, "agent-a", "b")).toMatchObject({
                dependsOn: ["a"],
            });
            await tasks.remove(database.context, "agent-a", "a");
            expect(await tasks.get(database.context, "agent-a", "b")).toMatchObject({
                dependsOn: [],
            });
        } finally {
            database.close();
        }
    });

    it("hides completed blockers only in list pages while detail retains the complete dependency record", async () => {
        const tasks = new TasksModule({ clock: () => 1, eventIdFactory: () => "event" });
        const database = moduleDatabase(tasks.migrations, "tasks-completed-blocker-test");
        await database.ready;
        try {
            await tasks.create(database.context, "agent-a", { id: "blocker", title: "Blocker" });
            await tasks.create(database.context, "agent-a", {
                id: "blocked",
                title: "Blocked",
                dependsOn: ["blocker"],
            });
            await tasks.complete(database.context, "agent-a", "blocker");
            expect((await tasks.listPage(database.context, "agent-a")).tasks).toMatchObject([
                { id: "blocker" },
                { id: "blocked", dependsOn: [] },
            ]);
            await expect(
                tasks.getPage(database.context, "agent-a", "blocked"),
            ).resolves.toMatchObject({
                task: { dependsOn: ["blocker"] },
                dependencies: ["blocker"],
                dependencyTotal: 1,
            });
        } finally {
            database.close();
        }
    });

    it("pages list and detail cursors with bounded output while preserving progress", async () => {
        let id = 0;
        const tasks = new TasksModule({
            maxOutputCharacters: 256,
            maxPageSize: 2,
            idFactory: () => `generated-${++id}`,
            eventIdFactory: () => `event-${id}`,
            clock: () => 1,
        });
        const database = moduleDatabase(tasks.migrations, "tasks-paging-output-test");
        await database.ready;
        try {
            for (let index = 0; index < 5; index += 1) {
                await tasks.create(database.context, "agent-a", {
                    id: `task-${index}`,
                    title: "x".repeat(500),
                    detail: "detail ".repeat(570),
                });
            }
            const offsets: number[] = [];
            let offset = 0;
            for (;;) {
                const page = await tasks.listPage(database.context, "agent-a", {
                    offset,
                    limit: 2,
                });
                expect(tasks.formatPageForModel(page).length).toBeLessThanOrEqual(256);
                offsets.push(page.offset);
                if (page.nextOffset === undefined) break;
                expect(page.nextOffset).toBeGreaterThan(offset);
                offset = page.nextOffset;
            }
            expect(offsets).toEqual([0, 1, 2, 3, 4]);

            const first = await tasks.getPage(database.context, "agent-a", "task-0", {
                detailLimit: 100,
            });
            expect(tasks.formatDetailPageForModel(first).length).toBeLessThanOrEqual(256);
            expect(first).toMatchObject({
                detailOffset: 0,
                detailTotal: 3_989,
                nextDetailOffset: 100,
            });
            const second = await tasks.getPage(database.context, "agent-a", "task-0", {
                detailOffset: first.task === null ? 0 : (first.nextDetailOffset ?? 0),
                detailLimit: 100,
            });
            expect(second).toMatchObject({ detailOffset: 100, detailTotal: 3_989 });
            await expect(tasks.getPage(database.context, "agent-a", "missing")).resolves.toEqual({
                task: null,
            });
        } finally {
            database.close();
        }
    });

    it("uses one tool surface with durable flags, correct scope, and no Auto review", async () => {
        const tasks = new TasksModule({ idFactory: () => "tool-task" });
        const database = moduleDatabase(tasks.migrations, "tasks-tool-surface-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, tasks);
            const tools = await hooks.tools!(database.context, {
                agent: { id: "agent-a" },
            } as never);
            expect(tools.map((tool) => tool.name)).toEqual([
                "create_task",
                "list_tasks",
                "get_task",
                "update_task",
                "complete_task",
                "remove_task",
            ]);
            expect(tools.every((tool) => tool.durable)).toBe(true);
            expect(
                tools.every(
                    (tool) => tool.shouldReviewInAutoMode({} as never, database.context) === false,
                ),
            ).toBe(true);
            expect(tools.map((tool) => tool.transactional ?? false)).toEqual([
                true,
                false,
                false,
                true,
                true,
                true,
            ]);
        } finally {
            database.close();
        }
    });

    it("does not publish task events or state after an outer rollback or transactional listener failure", async () => {
        const transactional: unknown[] = [];
        const postCommit: unknown[] = [];
        const tasks = new TasksModule({
            idFactory: () => "task",
            eventIdFactory: () => "event",
            listener: {
                onEventTransactional: (_ctx, event) => transactional.push(event),
                onEvent: (_ctx, event) => postCommit.push(event),
            },
        });
        const database = moduleDatabase(tasks.migrations, "tasks-rollback-events-test");
        await database.ready;
        try {
            await expect(
                database.context.inTx(async (ctx) => {
                    await tasks.create(ctx, "agent-a", { title: "rollback" });
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");
            expect(transactional).toHaveLength(1);
            expect(postCommit).toHaveLength(0);
            await expect(tasks.list(database.context, "agent-a")).resolves.toEqual([]);

            const rejected = new TasksModule({
                idFactory: () => "rejected",
                eventIdFactory: () => "rejected-event",
                listener: {
                    onEventTransactional: () => {
                        throw new Error("reject task");
                    },
                },
            });
            await expect(
                rejected.create(database.context, "agent-a", { title: "rejected" }),
            ).rejects.toThrow("reject task");
            await expect(rejected.list(database.context, "agent-a")).resolves.toEqual([]);
        } finally {
            database.close();
        }
    });

    it("delivers one deeply frozen event to transactional and post-commit listeners", async () => {
        let transactionalEvent: unknown;
        let postCommitEvent: unknown;
        const listener = {
            onEventTransactional: (_ctx: unknown, event: unknown) => {
                transactionalEvent = event;
            },
            onEvent: (_ctx: unknown, event: unknown) => {
                postCommitEvent = event;
            },
        };
        const tasks = new TasksModule({
            listener,
            idFactory: () => "task",
            eventIdFactory: () => "event",
            clock: () => 100,
        });
        const database = moduleDatabase(tasks.migrations, "tasks-event-freeze-test");
        await database.ready;
        try {
            await tasks.create(database.context, "agent-a", {
                title: "task",
                metadata: { nested: { values: ["x"] } },
            });
            expect(postCommitEvent).toBe(transactionalEvent);
            expect(transactionalEvent).toMatchObject({
                type: "task_created",
                eventId: "event",
                at: 100,
            });
            expect(Object.isFrozen(transactionalEvent)).toBe(true);
            if (
                typeof transactionalEvent === "object" &&
                transactionalEvent !== null &&
                "task" in transactionalEvent
            ) {
                const eventTask = transactionalEvent.task as {
                    metadata?: { nested?: { values?: unknown[] } };
                };
                expect(Object.isFrozen(eventTask)).toBe(true);
                if (eventTask.metadata !== undefined) {
                    expect(Object.isFrozen(eventTask.metadata)).toBe(true);
                    if (eventTask.metadata.nested !== undefined) {
                        expect(Object.isFrozen(eventTask.metadata.nested)).toBe(true);
                        expect(Object.isFrozen(eventTask.metadata.nested.values)).toBe(true);
                    }
                }
            }
        } finally {
            database.close();
        }
    });

    it("contains post-commit listener and error-reporter failures after durable commit", async () => {
        const reports: unknown[] = [];
        const tasks = new TasksModule({
            idFactory: () => "task",
            eventIdFactory: () => "event",
            onPostCommitError: (_ctx, event, error) => {
                reports.push({ event, error });
                throw {
                    toString: () => {
                        throw new Error("hostile");
                    },
                };
            },
            listener: {
                onEvent: () => {
                    throw new Error("observer failed");
                },
            },
        });
        const database = moduleDatabase(tasks.migrations, "tasks-post-commit-errors-test");
        await database.ready;
        try {
            await expect(
                tasks.create(database.context, "agent-a", { title: "persisted" }),
            ).resolves.toMatchObject({
                id: "task",
            });
            expect(reports).toHaveLength(1);
            await expect(tasks.get(database.context, "agent-a", "task")).resolves.toMatchObject({
                title: "persisted",
            });
        } finally {
            database.close();
        }
    });

    it("serializes concurrent mutations through the transaction boundary without losing tasks", async () => {
        const tasks = new TasksModule({
            maxTasks: 20,
            clock: () => 1,
            eventIdFactory: (() => {
                let id = 0;
                return () => `event-${++id}`;
            })(),
        });
        const database = moduleDatabase(tasks.migrations, "tasks-concurrency-test");
        await database.ready;
        try {
            await database.context.inTx(async (txCtx) => {
                await Promise.all(
                    Array.from({ length: 10 }, (_, index) =>
                        tasks.create(txCtx, "agent-a", {
                            id: `task-${index}`,
                            title: `Task ${index}`,
                        }),
                    ),
                );
            });
            const result = await tasks.list(database.context, "agent-a");
            expect(result).toHaveLength(10);
            expect(new Set(result.map((task) => task.id)).size).toBe(10);
            expect(result.map((task) => task.ordering)).toEqual(
                Array.from({ length: 10 }, (_, index) => index),
            );
        } finally {
            database.close();
        }
    });

    it("keeps mutation return values detached from durable storage", async () => {
        const tasks = new TasksModule({ clock: () => 1, eventIdFactory: () => "event" });
        const database = moduleDatabase(tasks.migrations, "tasks-return-clone-test");
        await database.ready;
        try {
            const created = await tasks.create(database.context, "agent-a", {
                id: "task",
                title: "original",
                metadata: { nested: { value: 1 } },
            });
            created.title = "mutated caller result";
            (created.metadata as { nested: { value: number } }).nested.value = 99;
            await expect(tasks.get(database.context, "agent-a", "task")).resolves.toMatchObject({
                title: "original",
                metadata: { nested: { value: 1 } },
            });
        } finally {
            database.close();
        }
    });

    it("reports typed failures for unknown and invalid tool mutations", async () => {
        const tasks = new TasksModule({ idFactory: () => "tool-task" });
        const database = moduleDatabase(tasks.migrations, "tasks-typed-tool-failures-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, tasks);
            const [, , get, update, complete, remove] = await hooks.tools!(database.context, {
                agent: { id: "agent-a" },
            } as never);
            const call = (id: string) =>
                ({ id, providerCallId: `provider-${id}`, kv: {} }) as never;
            await expect(
                get!.execute(database.context, { id: "missing" }, call("get")),
            ).resolves.toEqual({
                task: null,
            });
            await expect(
                update!.execute(
                    database.context,
                    { id: "missing", title: "missing" },
                    call("update"),
                ),
            ).resolves.toMatchObject({
                success: false,
                taskId: "missing",
            });
            await expect(
                complete!.execute(database.context, { id: "missing" }, call("complete")),
            ).resolves.toMatchObject({
                success: false,
                taskId: "missing",
            });
            await expect(
                remove!.execute(database.context, { id: "missing" }, call("remove")),
            ).resolves.toMatchObject({
                success: false,
                taskId: "missing",
            });
        } finally {
            database.close();
        }
    });

    it("emits the correct event variant for every changing mutation and no event for no-ops", async () => {
        const transactional: { type: string; eventId: string }[] = [];
        const committed: { type: string; eventId: string }[] = [];
        let eventNumber = 0;
        let clock = 0;
        const tasks = new TasksModule({
            idFactory: () => "task",
            eventIdFactory: () => `event-${++eventNumber}`,
            clock: () => ++clock,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
                onEvent: (_ctx, event) => {
                    committed.push(event);
                },
            },
        });
        const database = moduleDatabase(tasks.migrations, "tasks-event-variants-test");
        await database.ready;
        try {
            await tasks.create(database.context, "agent-a", { title: "task" });
            await tasks.update(database.context, "agent-a", "task", { priority: "high" });
            await tasks.update(database.context, "agent-a", "task", { status: "completed" });
            await tasks.complete(database.context, "agent-a", "task");
            await tasks.update(database.context, "agent-a", "task", { status: "pending" });
            await tasks.reorder(database.context, "agent-a", ["task"]);
            await expect(tasks.remove(database.context, "agent-a", "missing")).resolves.toBe(false);
            await expect(tasks.reset(database.context, "agent-a")).resolves.toBe(1);
            await expect(tasks.reset(database.context, "agent-a")).resolves.toBe(0);

            expect(transactional.map((event) => event.type)).toEqual([
                "task_created",
                "task_updated",
                "task_completed",
                "task_updated",
                "tasks_reset",
            ]);
            expect(committed).toEqual(transactional);
            expect(committed.map((event) => event.eventId)).toEqual([
                "event-1",
                "event-2",
                "event-3",
                "event-5",
                "event-8",
            ]);
        } finally {
            database.close();
        }
    });

    it("does not require event identity allocation for no-op mutations", async () => {
        let eventFactoryCalls = 0;
        const tasks = new TasksModule({
            idFactory: () => "task",
            eventIdFactory: () => `event-${++eventFactoryCalls}`,
            clock: () => 1,
        });
        const database = moduleDatabase(tasks.migrations, "tasks-no-op-factory-test");
        await database.ready;
        try {
            await tasks.create(database.context, "agent-a", { title: "task" });
            await tasks.complete(database.context, "agent-a", "task");
            const callsAfterChange = eventFactoryCalls;
            await expect(
                tasks.complete(database.context, "agent-a", "task"),
            ).resolves.toMatchObject({
                status: "completed",
            });
            await expect(tasks.remove(database.context, "agent-a", "missing")).resolves.toBe(false);
            await expect(tasks.reset(database.context, "agent-a")).resolves.toBe(1);
            await tasks.reset(database.context, "agent-a");
            expect(eventFactoryCalls).toBe(callsAfterChange);
        } finally {
            database.close();
        }
    });

    it("supports asynchronous ID and event factories", async () => {
        const seen: string[] = [];
        const tasks = new TasksModule({
            idFactory: async (_ctx, agentId) => {
                expect(agentId).toBe("agent-a");
                return "async-task";
            },
            eventIdFactory: async (_ctx, agentId) => {
                expect(agentId).toBe("agent-a");
                return "async-event";
            },
            listener: {
                onEventTransactional: (_ctx, event) => {
                    seen.push(`tx:${event.type}`);
                },
                onEvent: (_ctx, event) => {
                    seen.push(`post:${event.type}`);
                },
            },
        });
        const database = moduleDatabase(tasks.migrations, "tasks-async-factories-test");
        await database.ready;
        try {
            await expect(
                tasks.create(database.context, "agent-a", { title: "task" }),
            ).resolves.toMatchObject({ id: "async-task" });
            expect(seen).toEqual(["tx:task_created", "post:task_created"]);
        } finally {
            database.close();
        }
    });

    it("lets transactional observers read the staged state and post-commit observers read committed state", async () => {
        let module: TasksModule;
        let transactionalTask: unknown;
        let postCommitTask: unknown;
        let transactionalContext: unknown;
        let postCommitContext: unknown;
        module = new TasksModule({
            idFactory: () => "task",
            eventIdFactory: () => "event",
            listener: {
                onEventTransactional: async (ctx) => {
                    transactionalContext = ctx;
                    transactionalTask = await module.get(ctx, "agent-a", "task");
                },
                onEvent: async (ctx) => {
                    postCommitContext = ctx;
                    postCommitTask = await module.get(ctx, "agent-a", "task");
                },
            },
        });
        const database = moduleDatabase(module.migrations, "tasks-event-context-test");
        await database.ready;
        try {
            await module.create(database.context, "agent-a", { title: "task" });
            expect(transactionalTask).toMatchObject({ id: "task", title: "task" });
            expect(postCommitTask).toMatchObject({ id: "task", title: "task" });
            expect(transactionalContext).toBeDefined();
            expect(postCommitContext).toBeDefined();
            expect(postCommitContext).not.toBe(transactionalContext);
        } finally {
            database.close();
        }
    });

    it("accepts class-backed listeners and invokes their methods with the owning receiver", async () => {
        class Listener {
            readonly seen: string[] = [];

            onEventTransactional(_ctx: unknown, event: { readonly type: string }): void {
                this.seen.push(`tx:${event.type}`);
            }

            onEvent(_ctx: unknown, event: { readonly type: string }): void {
                this.seen.push(`post:${event.type}`);
            }
        }
        const listener = new Listener();
        const tasks = new TasksModule({ listener });
        const database = moduleDatabase(tasks.migrations, "tasks-class-listener-test");
        await database.ready;
        try {
            await expect(
                tasks.create(database.context, "agent-a", { title: "task" }),
            ).resolves.toMatchObject({ id: expect.any(String) });
            expect(listener.seen).toEqual(["tx:task_created", "post:task_created"]);
        } finally {
            database.close();
        }
    });

    it("rejects persisted lists over the configured maximum and re-runs migrations idempotently", async () => {
        const tasks = new TasksModule({ maxTasks: 2 });
        const database = moduleDatabase(tasks.migrations, "tasks-persisted-max-test");
        await database.ready;
        try {
            await expect(
                tasks.migrations[0]?.[1](database.context, database.database),
            ).resolves.toBeUndefined();
            await seedTasks(
                database,
                "agent-a",
                JSON.stringify([
                    baseTask(),
                    baseTask({ id: "task-b", ordering: 1 }),
                    baseTask({ id: "task-c", ordering: 2 }),
                ]),
            );
            await expect(tasks.list(database.context, "agent-a")).rejects.toThrow(
                "configured bounds",
            );
        } finally {
            database.close();
        }
    });

    it("validates bounded list and detail queries before reading storage", async () => {
        const tasks = new TasksModule({ maxPageSize: 2 });
        const database = moduleDatabase(tasks.migrations, "tasks-query-validation-test");
        await database.ready;
        try {
            await expect(tasks.listPage(database.context, "agent-a", { limit: 0 })).rejects.toThrow(
                "Invalid task page query",
            );
            await expect(tasks.listPage(database.context, "agent-a", { limit: 3 })).rejects.toThrow(
                "cannot exceed 2",
            );
            await expect(
                tasks.listPage(database.context, "agent-a", { offset: -1 }),
            ).rejects.toThrow("Invalid task page query");
            await expect(
                tasks.listPage(database.context, "agent-a", { extra: true } as never),
            ).rejects.toThrow("Invalid task page query");
            await expect(
                tasks.getPage(database.context, "agent-a", "missing", { detailLimit: 0 }),
            ).rejects.toThrow("Invalid task detail query");
            await expect(
                tasks.getPage(database.context, "agent-a", "missing", { dependencyLimit: 65 }),
            ).rejects.toThrow("Invalid task detail query");
            await expect(
                tasks.getPage(database.context, "agent-a", "missing", { extra: true } as never),
            ).rejects.toThrow("Invalid task detail query");
        } finally {
            database.close();
        }
    });

    it("sorts a valid persisted list by ordering rather than JSON array position", async () => {
        const tasks = new TasksModule();
        const database = moduleDatabase(tasks.migrations, "tasks-persisted-order-test");
        await database.ready;
        try {
            await seedTasks(
                database,
                "agent-a",
                JSON.stringify([
                    baseTask({ id: "task-b", title: "B", ordering: 1 }),
                    baseTask({ id: "task-a", title: "A", ordering: 0 }),
                ]),
            );
            await expect(tasks.list(database.context, "agent-a")).resolves.toMatchObject([
                { id: "task-a", ordering: 0 },
                { id: "task-b", ordering: 1 },
            ]);
        } finally {
            database.close();
        }
    });

    it("binds every tool to its requested agent scope", async () => {
        const tasks = new TasksModule({ idFactory: () => "tool-task" });
        const database = moduleDatabase(tasks.migrations, "tasks-tool-scope-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, tasks);
            const scopeA = await hooks.tools!(database.context, {
                agent: { id: "agent-a" },
            } as never);
            const scopeB = await hooks.tools!(database.context, {
                agent: { id: "agent-b" },
            } as never);
            await scopeA[0]!.execute(database.context, { title: "A" }, {
                id: "call-a",
                providerCallId: "provider-a",
                kv: {},
            } as never);
            await expect(
                scopeB[1]!.execute(database.context, {}, {
                    id: "call-b",
                    providerCallId: "provider-b",
                    kv: {},
                } as never),
            ).resolves.toMatchObject({ tasks: [], total: 0 });
            await expect(
                scopeA[1]!.execute(database.context, {}, {
                    id: "call-a-list",
                    providerCallId: "provider-a-list",
                    kv: {},
                } as never),
            ).resolves.toMatchObject({ tasks: [{ id: "call-a" }], total: 1 });
        } finally {
            database.close();
        }
    });

    it("keeps direct model formatting bounded while preserving the task identity", async () => {
        const tasks = new TasksModule({ maxOutputCharacters: 256 });
        const task = {
            ...baseTask({
                id: "task-id",
                title: "x".repeat(500),
                detail: "detail ".repeat(500),
                metadata: { value: "metadata" },
            }),
        } as never;
        const output = tasks.formatForModel([task]);
        expect(output.length).toBeLessThanOrEqual(256);
        expect(output).toContain("task-id");
        expect(output).toContain("[task list truncated]");
    });

    it("keeps maximum-length dependency identities actionable under the minimum output bound", async () => {
        const tasks = new TasksModule({
            maxTasks: 100,
            maxOutputCharacters: 256,
            clock: () => 1,
            eventIdFactory: () => "event",
        });
        const database = moduleDatabase(tasks.migrations, "tasks-max-id-detail-output-test");
        await database.ready;
        try {
            const dependencies = Array.from({ length: 64 }, (_, index) =>
                `${index}`.padStart(128, "d"),
            );
            for (const id of dependencies) {
                await tasks.create(database.context, "agent-a", { id, title: "dependency" });
            }
            const target = "t".repeat(128);
            await tasks.create(database.context, "agent-a", {
                id: target,
                title: "target",
                dependsOn: dependencies,
            });
            const page = await tasks.getPage(database.context, "agent-a", target);
            expect(page.task).not.toBeNull();
            expect(tasks.formatDetailPageForModel(page).length).toBeLessThanOrEqual(256);
            if (page.task !== null) {
                expect(page.dependencies.length).toBeGreaterThan(0);
                expect(page.nextDependencyOffset).toBe(1);
                expect(page.dependencies[0]).toBe(dependencies[0]);
            }
        } finally {
            database.close();
        }
    });

    it("does not let rendered mutation results exceed the configured model-output bound", async () => {
        const tasks = new TasksModule({
            maxOutputCharacters: 256,
            idFactory: () => "task",
            eventIdFactory: () => "event",
        });
        const database = moduleDatabase(tasks.migrations, "tasks-mutation-output-bound-test");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, tasks);
            const [create, , , update, complete, remove] = await hooks.tools!(database.context, {
                agent: { id: "agent-a" },
            } as never);
            const createCall = { id: "task", providerCallId: "provider-task", kv: {} } as never;
            const created = await create!.execute(
                database.context,
                { title: "x".repeat(500) },
                createCall,
            );
            const updated = await update!.execute(
                database.context,
                { id: "task", priority: "high" },
                { id: "update", providerCallId: "provider-update", kv: {} } as never,
            );
            const completed = await complete!.execute(database.context, { id: "task" }, {
                id: "complete",
                providerCallId: "provider-complete",
                kv: {},
            } as never);
            const removed = await remove!.execute(database.context, { id: "task" }, {
                id: "remove",
                providerCallId: "provider-remove",
                kv: {},
            } as never);
            const outputs = [
                create!.toLLM(created as never),
                update!.toLLM(updated as never),
                complete!.toLLM(completed as never),
                remove!.toLLM(removed as never),
            ];
            const lengths = outputs.map((output) =>
                output
                    .map((block) => ("text" in block ? block.text.length : 0))
                    .reduce((a, b) => a + b, 0),
            );
            expect(Math.max(...lengths)).toBeLessThanOrEqual(256);
        } finally {
            database.close();
        }
    });
});
