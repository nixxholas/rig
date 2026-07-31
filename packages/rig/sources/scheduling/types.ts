import type { ToolResultBlock } from "../agent/types.js";

export const MAX_WAIT_MS = 24 * 60 * 60 * 1_000;

export interface WaitResult {
    elapsedSeconds: number;
    endedAt: number;
    interrupted: boolean;
    reason: "completed" | "message_received";
    startedAt: number;
    dueAt: number;
}

export interface DurableWait {
    arguments: unknown;
    batchId: string;
    consumed: boolean;
    createdAt: number;
    dueAt: number;
    id: string;
    kind: "wait" | "wait_until";
    providerToolCallId?: string;
    result?: WaitResult;
    resultBlock?: ToolResultBlock;
    runId: string;
    sessionId: string;
    status: "waiting" | "completed" | "interrupted" | "cancelled";
    toolCallId: string;
    toolCallIndex: number;
    toolName: "wait" | "wait_until";
}

export interface ScheduledMessage {
    createdAt: number;
    dueAt: number;
    id: string;
    message: string;
    senderSessionId: string;
    status: "pending" | "delivered" | "undelivered" | "cancelled";
    targetAgentId: string;
    updatedAt: number;
    deliveredAt?: number;
    failure?: string;
}

export interface DurableWaitRequest {
    arguments: unknown;
    batchId: string;
    dueAt: number;
    kind: DurableWait["kind"];
    providerToolCallId?: string;
    toolCallId: string;
    toolCallIndex: number;
    toolName: DurableWait["toolName"];
}

export interface ScheduleMessageRequest {
    dueAt: number;
    message: string;
    targetAgentId: string;
}
