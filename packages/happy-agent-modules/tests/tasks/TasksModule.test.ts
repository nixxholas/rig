import { describe, expect, it } from "vitest";

import { TasksModule } from "../../sources/tasks/TasksModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("TasksModule durable tools", () => {
    it("uses the tool-call ID and commits each mutation inside its state transaction", async () => {
        let database!: ReturnType<typeof moduleDatabase>;
        let transactionDepth = 0;
        let eventId = 0;
        const tasks = new TasksModule({
            transaction: async (ctx, work) => {
                transactionDepth += 1;
                try {
                    return await work(ctx, database.database);
                } finally {
                    transactionDepth -= 1;
                }
            },
            clock: () => 123,
            eventIdFactory: () => `event-${++eventId}`,
        });
        database = moduleDatabase(tasks.migrations, "tasks-tool-commit-test");
        await database.ready;

        try {
            const commitDepths: number[] = [];
            const commits: unknown[] = [];
            const call = (id: string) =>
                ({
                    id,
                    providerCallId: `provider-${id}`,
                    kv: {},
                    commit: async (_ctx: unknown, result: unknown) => {
                        commitDepths.push(transactionDepth);
                        commits.push(result);
                        return result;
                    },
                }) as never;
            const scope = { agent: { id: "agent-a" } } as Parameters<TasksModule["tools"]>[1];
            const [create, , , update, complete] = tasks.tools(database.context, scope);

            const created = await create!.execute(
                database.context,
                { title: "Ship the task cleanup" },
                call("call-task-1"),
            );
            expect(created.task.id).toBe("call-task-1");

            const updated = await update!.execute(
                database.context,
                { id: created.task.id, priority: "high" },
                call("call-update-1"),
            );
            expect(updated.task.priority).toBe("high");

            const completed = await complete!.execute(
                database.context,
                { id: created.task.id },
                call("call-complete-1"),
            );
            expect(completed.task.status).toBe("completed");
            expect(commitDepths).toEqual([1, 1, 1]);
            expect(commits).toEqual([
                { task: created.task },
                { task: updated.task },
                { task: completed.task },
            ]);

            await expect(
                create!.execute(
                    database.context,
                    { title: "Ship the task cleanup" },
                    call("call-task-1"),
                ),
            ).rejects.toThrow('Task "call-task-1" already exists.');
            expect(commits).toHaveLength(3);
        } finally {
            database.close();
        }
    });

    it("treats an existing public task ID as a conflict even for identical input", async () => {
        let database!: ReturnType<typeof moduleDatabase>;
        const tasks = new TasksModule({
            transaction: async (ctx, work) => await work(ctx, database.database),
            clock: () => 123,
            eventIdFactory: () => "event-1",
        });
        database = moduleDatabase(tasks.migrations, "tasks-existing-id-test");
        await database.ready;

        try {
            const input = { id: "existing", title: "Existing task" } as const;
            await tasks.create(database.context, "agent-a", input);
            await expect(tasks.create(database.context, "agent-a", input)).rejects.toThrow(
                'Task "existing" already exists.',
            );
        } finally {
            database.close();
        }
    });
});