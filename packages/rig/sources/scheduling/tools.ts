import { Type } from "@sinclair/typebox";

import { defineTool, type AnyDefinedTool } from "../agent/types.js";
import { parseDateMs, parseDurationMs, parseWaitUntilMs } from "./parseScheduleTime.js";
import { MAX_WAIT_MS, type WaitResult } from "./types.js";

const durationProperties = {
    days: Type.Optional(Type.Number({ description: "Days to wait. May be fractional." })),
    duration: Type.Optional(
        Type.String({ description: "Human-readable duration such as '90 seconds' or '1h 30m'." }),
    ),
    hours: Type.Optional(Type.Number({ description: "Hours to wait. May be fractional." })),
    seconds: Type.Optional(Type.Number({ description: "Seconds to wait. May be fractional." })),
};

const waitResult = Type.Object(
    {
        elapsed_seconds: Type.Number(),
        ended_at: Type.String(),
        interrupted: Type.Boolean(),
        reason: Type.Union([Type.Literal("completed"), Type.Literal("message_received")]),
        started_at: Type.String(),
        due_at: Type.String(),
    },
    { additionalProperties: false },
);

export const waitTool = defineTool({
    name: "wait",
    label: "wait",
    description:
        "Durably wait for up to 24 hours. The wait survives daemon restarts. A new message in this chat ends it early and the result reports the actual elapsed time.",
    arguments: Type.Object(durationProperties, { additionalProperties: false }),
    returnType: waitResult,
    execution: "durable",
    steerable: false,
    async execute(args, context, execution) {
        const scheduling = requireScheduling(context.scheduling);
        const dueAt = scheduling.now() + parseDurationMs(args, MAX_WAIT_MS);
        return toToolResult(
            await scheduling.wait(
                {
                    arguments: args,
                    batchId: requireIdentity(execution.toolBatchId),
                    dueAt,
                    kind: "wait",
                    ...(execution.providerToolCallId === undefined
                        ? {}
                        : { providerToolCallId: execution.providerToolCallId }),
                    toolCallId: requireIdentity(execution.toolCallId),
                    toolCallIndex: requireIndex(execution.toolCallIndex),
                    toolName: "wait",
                },
                execution.signal,
            ),
        );
    },
    toLLM: (result) => [
        {
            type: "text",
            text: result.interrupted
                ? `The wait ended early because a new message arrived after ${formatSeconds(result.elapsed_seconds)} seconds.`
                : `The wait completed after ${formatSeconds(result.elapsed_seconds)} seconds.`,
        },
    ],
    toUI: (result) =>
        result.interrupted
            ? `Wait interrupted after ${formatSeconds(result.elapsed_seconds)} seconds`
            : `Waited ${formatSeconds(result.elapsed_seconds)} seconds`,
    interruptionMessage: "The durable wait was interrupted.",
    shouldReviewInAutoMode: () => false,
    locks: [],
});

export const waitUntilTool = defineTool({
    name: "wait_until",
    label: "wait_until",
    description:
        "Durably wait until a date no more than 24 hours away. Accepts ISO 8601, RFC 2822, Unix seconds, or Unix milliseconds. A new message in this chat ends it early.",
    arguments: Type.Object(
        {
            at: Type.Union([
                Type.String({ description: "Date and time, preferably ISO 8601 with a timezone." }),
                Type.Number({ description: "Unix timestamp in seconds or milliseconds." }),
            ]),
        },
        { additionalProperties: false },
    ),
    returnType: waitResult,
    execution: "durable",
    steerable: false,
    async execute(args, context, execution) {
        const scheduling = requireScheduling(context.scheduling);
        const dueAt = parseWaitUntilMs(args.at, scheduling.now());
        return toToolResult(
            await scheduling.wait(
                {
                    arguments: args,
                    batchId: requireIdentity(execution.toolBatchId),
                    dueAt,
                    kind: "wait_until",
                    ...(execution.providerToolCallId === undefined
                        ? {}
                        : { providerToolCallId: execution.providerToolCallId }),
                    toolCallId: requireIdentity(execution.toolCallId),
                    toolCallIndex: requireIndex(execution.toolCallIndex),
                    toolName: "wait_until",
                },
                execution.signal,
            ),
        );
    },
    toLLM: waitTool.toLLM,
    toUI: (result) =>
        result.interrupted
            ? `Wait interrupted after ${formatSeconds(result.elapsed_seconds)} seconds`
            : `Waited ${formatSeconds(result.elapsed_seconds)} seconds`,
    interruptionMessage: "The durable wait was interrupted.",
    shouldReviewInAutoMode: () => false,
    locks: [],
});

export const scheduleMessageTool = defineTool({
    name: "schedule_message",
    label: "schedule_message",
    description:
        "Schedule a message to any Rig agent whose exact Agent ID you know, including yourself. Use at for a date or use duration, seconds, hours, and days for a delay. If delivery fails, the scheduled message remains with this agent.",
    arguments: Type.Object(
        {
            agent_id: Type.String({ description: "Exact unguessable Agent ID of the recipient." }),
            at: Type.Optional(
                Type.Union([
                    Type.String({
                        description: "ISO 8601, RFC 2822, Unix seconds, or Unix milliseconds.",
                    }),
                    Type.Number({ description: "Unix timestamp in seconds or milliseconds." }),
                ]),
            ),
            message: Type.String({ minLength: 1 }),
            ...durationProperties,
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        {
            id: Type.String(),
            due_at: Type.String(),
            status: Type.Literal("pending"),
            target_agent_id: Type.String(),
        },
        { additionalProperties: false },
    ),
    execute(args, context) {
        const scheduling = requireScheduling(context.scheduling);
        const { at, agent_id: targetAgentId, message, ...duration } = args;
        const hasDuration = Object.values(duration).some((value) => value !== undefined);
        if (at !== undefined && hasDuration) {
            throw new Error("Use either at or a delay duration, not both.");
        }
        const dueAt =
            at === undefined
                ? scheduling.now() + parseDurationMs(duration)
                : Math.max(scheduling.now(), parseDateMs(at));
        const scheduled = scheduling.scheduleMessage({ dueAt, message, targetAgentId });
        return {
            due_at: new Date(scheduled.dueAt).toISOString(),
            id: scheduled.id,
            status: "pending" as const,
            target_agent_id: scheduled.targetAgentId,
        };
    },
    toLLM: (result) => [
        {
            type: "text",
            text: `Scheduled message ${result.id} for ${result.target_agent_id} at ${result.due_at}.`,
        },
    ],
    toUI: (result) => `Message scheduled for ${result.due_at}`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});

export const schedulingTools: readonly AnyDefinedTool[] = [
    waitTool,
    waitUntilTool,
    scheduleMessageTool,
];

function requireScheduling(
    scheduling: import("./SchedulingContext.js").SchedulingContext | undefined,
): import("./SchedulingContext.js").SchedulingContext {
    if (scheduling === undefined) {
        throw new Error("Scheduling is unavailable in this session.");
    }
    return scheduling;
}

function requireIdentity(value: string | undefined): string {
    if (value === undefined) throw new Error("Durable wait execution identity is missing.");
    return value;
}

function requireIndex(value: number | undefined): number {
    if (value === undefined) throw new Error("Durable wait execution identity is missing.");
    return value;
}

function toToolResult(result: WaitResult) {
    return {
        due_at: new Date(result.dueAt).toISOString(),
        elapsed_seconds: result.elapsedSeconds,
        ended_at: new Date(result.endedAt).toISOString(),
        interrupted: result.interrupted,
        reason: result.reason,
        started_at: new Date(result.startedAt).toISOString(),
    };
}

function formatSeconds(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "");
}
