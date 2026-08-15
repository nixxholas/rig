import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { TasksModule } from "../TasksModule.js";
import { taskIdSchema, taskSchema } from "../Task.js";

const completeTaskInputSchema = Type.Object({ id: taskIdSchema }, { additionalProperties: false });

/** Mark one task complete. Repeating this call returns the same task. */
export function completeTaskTool(tasks: TasksModule, agentId: string) {
    return defineAgentTool({
        name: "complete_task",
        description: "Mark a task completed after its work has been finished and verified.",
        parameters: completeTaskInputSchema,
        returnType: Type.Object({ task: taskSchema }),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }) => {
            const task = await tasks.complete(ctx, agentId, id);
            return { task };
        },
        toLLM: ({ task }) => [
            {
                type: "text",
                text: `Task completed: ${task.id}\n${task.title}`,
            },
        ],
    });
}
