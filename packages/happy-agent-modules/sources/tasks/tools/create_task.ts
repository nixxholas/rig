import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksModule } from "../TasksModule.js";
import {
    taskSchema,
    taskDetailSchema,
    taskIdSchema,
    taskPrioritySchema,
    taskTitleSchema,
    type TaskCreateInput,
} from "../Task.js";

const taskToolCreateInputSchema = Type.Object(
    {
        title: taskTitleSchema,
        detail: Type.Optional(taskDetailSchema),
        priority: Type.Optional(taskPrioritySchema),
        dependsOn: Type.Optional(Type.Array(taskIdSchema, { maxItems: 64, uniqueItems: true })),
    },
    { additionalProperties: false },
);

/** Create one durable task using the stable invocation ID as its task ID. */
export function createTaskTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "create_task",
        description:
            "Create one persistent task in this agent's task list.",
        parameters: taskToolCreateInputSchema,
        returnType: Type.Object({ task: taskSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: TaskCreateInput, call) => {
            const task = await tasks.create(
                ctx,
                agentId,
                { ...input, id: call.id },
                async (txCtx, created) =>
                    (
                        await call.commit(txCtx, {
                            task: created,
                        })
                    ).task,
            );
            return { task };
        },
        toLLM: ({ task }) => [
            {
                type: "text",
                text: `Task created: ${task.id}\n${task.title}`,
            },
        ],
    });
}
