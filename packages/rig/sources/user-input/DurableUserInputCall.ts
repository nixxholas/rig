import type { ToolResultBlock } from "../agent/types.js";

import type { UserInputRequest, UserInputResponse } from "./types.js";

export interface DurableUserInputPermission {
    action: string;
    reason: string;
}

export interface DurableUserInputCall {
    /** Exact deadline for the active presence wait, persisted across daemon restarts. */
    answerDueAt?: number;
    /** When the active presence wait began. */
    answerWaitStartedAt?: number;
    batchId: string;
    consumed: boolean;
    createdAt: number;
    /** When presence released the run from waiting for this answer. */
    detachedAt?: number;
    kind: "permission" | "question";
    permission?: DurableUserInputPermission;
    providerToolCallId?: string;
    request: UserInputRequest;
    response?: UserInputResponse;
    resolvedAt?: number;
    result?: ToolResultBlock;
    runId: string;
    sessionId: string;
    status: "pending" | "answered" | "executing" | "completed" | "cancelled";
    toolArguments: unknown;
    toolCallId: string;
    toolCallIndex: number;
    toolName: string;
}

export interface DurableUserInputOptions {
    batchId: string;
    kind: DurableUserInputCall["kind"];
    permission?: DurableUserInputPermission;
    providerToolCallId?: string;
    toolArguments: unknown;
    toolCallId: string;
    toolCallIndex: number;
    toolName: string;
}
