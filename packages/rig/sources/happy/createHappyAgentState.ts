import type { UserInputRequest } from "../user-input/index.js";

/**
 * Happy only knows how to render one interactive form, the one Claude's
 * `AskUserQuestion` tool produces. Rig asks the same shape from several tools
 * (`AskUserQuestion`, Codex's `request_user_input`, MCP elicitation), so every
 * pending question is published under that name regardless of its origin.
 */
const HAPPY_QUESTION_TOOL = "AskUserQuestion";
const MAX_COMPLETED_REQUESTS = 100;

export interface HappyResolvedRequest {
    arguments: unknown;
    completedAt: number;
    createdAt: number;
    status: "approved" | "canceled";
}

interface HappyAgentState {
    completedRequests: Record<string, unknown>;
    requests: Record<string, unknown>;
}

/**
 * Keeps enough recent completions for Happy to settle delayed permission cards
 * without letting a months-long session grow this live-state payload forever.
 */
export function rememberHappyResolvedRequest(
    completed: Map<string, HappyResolvedRequest>,
    requestId: string,
    request: HappyResolvedRequest,
): void {
    completed.delete(requestId);
    completed.set(requestId, request);
    while (completed.size > MAX_COMPLETED_REQUESTS) {
        const oldestRequestId = completed.keys().next().value;
        if (oldestRequestId === undefined) return;
        completed.delete(oldestRequestId);
    }
}

/**
 * Projects Rig's pending questions into Happy's permission-request state. Happy
 * joins each entry onto its tool call by id, and Rig uses the tool call id as
 * the question's request id, so the two line up without extra bookkeeping.
 *
 * Returns null when there is nothing to publish, which clears the remote state.
 */
export function createHappyAgentState(options: {
    completed: ReadonlyMap<string, HappyResolvedRequest>;
    /**
     * When the question was first seen. This has to stay stable across
     * publishes: the caller skips the round trip only when the serialized state
     * is byte-identical, so a moving timestamp republishes on every sync tick.
     */
    createdAt: (requestId: string) => number;
    pending: readonly UserInputRequest[];
}): HappyAgentState | null {
    const requests: Record<string, unknown> = {};
    for (const request of options.pending) {
        requests[request.requestId] = {
            arguments: toHappyArguments(request),
            createdAt: options.createdAt(request.requestId),
            tool: HAPPY_QUESTION_TOOL,
        };
    }

    const completedRequests: Record<string, unknown> = {};
    for (const [requestId, resolved] of options.completed) {
        // A question that is pending again takes precedence over a stale answer.
        if (requests[requestId] !== undefined) continue;
        completedRequests[requestId] = {
            arguments: resolved.arguments,
            completedAt: resolved.completedAt,
            createdAt: resolved.createdAt,
            status: resolved.status,
            ...(resolved.status === "approved" ? { decision: "approved" } : {}),
            tool: HAPPY_QUESTION_TOOL,
        };
    }

    if (Object.keys(requests).length === 0 && Object.keys(completedRequests).length === 0) {
        return null;
    }
    return { completedRequests, requests };
}

/**
 * Happy reads `question`, `header`, `options`, and `multiSelect`; the request id
 * rides along untouched so an answer can be matched back to its question.
 */
export function toHappyArguments(request: UserInputRequest): unknown {
    return {
        questions: request.questions.map((question) => ({
            header: question.header,
            id: question.id,
            multiSelect: question.multiSelect,
            options: question.options.map((option) => ({
                description: option.description,
                label: option.label,
            })),
            question: question.question,
        })),
    };
}
