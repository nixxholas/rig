import { describe, expect, it } from "vitest";

import { TasksModule } from "../../sources/tasks/TasksModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("TasksModule durable tools", () => {
    it("uses the tool-call ID and marks each mutation transactional", async () => {
        let eventId = 0;
        const tasks = new TasksModule({
            clock: () => 123,
            eventIdFactory: () => `event-${++eventId}`,
        });
        const database = moduleDatabase(tasks.migrations, "tasks-tool-commit-test");
        await database.ready;

        try {
            const call = (id: string) =>
                ({
                    id,
                    providerCallId: `provider-${id}`,
                    kv: {},
                }) as never;
            const scope = { agent: { id: "agent-a" } } as Parameters<TasksModule["tools"]>[1];
            const [create, , , update, complete] = tasks.tools(database.context, scope);
            expect([create?.transactional, update?.transactional, complete?.transactional]).toEqual([
                true,
                true,
                true,
            ]);

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

            await expect(
                create!.execute(
                    database.context,
                    { title: "Ship the task cleanup" },
                    call("call-task-1"),
                ),
            ).rejects.toThrow('Task "call-task-1" already exists.');
        } finally {
            database.close();
        }
    });

    it("treats an existing public task ID as a conflict even for identical input", async () => {
        const tasks = new TasksModule({
            clock: () => 123,
            eventIdFactory: () => "event-1",
        });
        const database = moduleDatabase(tasks.migrations, "tasks-existing-id-test");
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