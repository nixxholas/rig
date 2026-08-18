import { Type, type Static } from "@sinclair/typebox";

import { taskIdSchema, taskSchema, taskTimestampSchema, taskUpdateInputSchema } from "./Task.js";

const agentIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export const taskEventIdSchema = Type.String({ minLength: 1, maxLength: 128 });

const taskCreatedEventPayloadSchema = Type.Object(
    {
        type: Type.Literal("task_created"),
        agentId: agentIdSchema,
        task: taskSchema,
    },
    { additionalProperties: false },
);
const taskUpdatedEventPayloadSchema = Type.Object(
    {
        type: Type.Literal("task_updated"),
        agentId: agentIdSchema,
        task: taskSchema,
        changes: taskUpdateInputSchema,
    },
    { additionalProperties: false },
);
const taskCompletedEventPayloadSchema = Type.Object(
    {
        type: Type.Literal("task_completed"),
        agentId: agentIdSchema,
        task: taskSchema,
    },
    { additionalProperties: false },
);
const taskRemovedEventPayloadSchema = Type.Object(
    {
        type: Type.Literal("task_removed"),
        agentId: agentIdSchema,
        taskId: taskIdSchema,
    },
    { additionalProperties: false },
);
const tasksReorderedEventPayloadSchema = Type.Object(
    {
        type: Type.Literal("tasks_reordered"),
        agentId: agentIdSchema,
        tasks: Type.Array(taskSchema, { maxItems: 500 }),
    },
    { additionalProperties: false },
);
const tasksResetEventPayloadSchema = Type.Object(
    {
        type: Type.Literal("tasks_reset"),
        agentId: agentIdSchema,
        removed: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

/** Runtime shape of an event payload before identity and timestamp are attached. */
export const taskEventPayloadSchema = Type.Union([
    taskCreatedEventPayloadSchema,
    taskUpdatedEventPayloadSchema,
    taskCompletedEventPayloadSchema,
    taskRemovedEventPayloadSchema,
    tasksReorderedEventPayloadSchema,
    tasksResetEventPayloadSchema,
]);

const opaqueContextSchema = Type.Any();
const opaqueResultSchema = Type.Any();

/** Runtime shape of every event a task mutation can announce. */
export const taskEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("task_created"),
            eventId: taskEventIdSchema,
            at: taskTimestampSchema,
            agentId: agentIdSchema,
            task: taskSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("task_updated"),
            eventId: taskEventIdSchema,
            at: taskTimestampSchema,
            agentId: agentIdSchema,
            task: taskSchema,
            changes: taskUpdateInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("task_completed"),
            eventId: taskEventIdSchema,
            at: taskTimestampSchema,
            agentId: agentIdSchema,
            task: taskSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("task_removed"),
            eventId: taskEventIdSchema,
            at: taskTimestampSchema,
            agentId: agentIdSchema,
            taskId: taskIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("tasks_reordered"),
            eventId: taskEventIdSchema,
            at: taskTimestampSchema,
            agentId: agentIdSchema,
            tasks: Type.Array(taskSchema, { maxItems: 500 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("tasks_reset"),
            eventId: taskEventIdSchema,
            at: taskTimestampSchema,
            agentId: agentIdSchema,
            removed: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
    ),
]);

/** A durable change made to one agent's task list. */
export type TaskEvent = Static<typeof taskEventSchema>;

/** Event payload before the module adds its stable event identity and timestamp. */
export type TaskEventPayload = Static<typeof taskEventPayloadSchema>;

/**
 * Whoever the task module reports to. The transactional callback runs before the task list's
 * transaction commits; the ordinary callback runs after it commits and cannot roll it back.
 *
 * This is a structural seam, so it asks only for the two callbacks and stays silent about anything
 * else the listener is. A host is free to pass an object of its own that happens to keep state
 * beside them, and a class instance whose methods live on its prototype is an ordinary listener
 * rather than a malformed one.
 */
export const taskModuleListenerSchema = Type.Object({
    onEventTransactional: Type.Optional(
        Type.Function([opaqueContextSchema, taskEventSchema], opaqueResultSchema),
    ),
    onEvent: Type.Optional(
        Type.Function([opaqueContextSchema, taskEventSchema], opaqueResultSchema),
    ),
});

export type TaskModuleListener = Static<typeof taskModuleListenerSchema>;
