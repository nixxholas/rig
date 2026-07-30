import type { UserInputRequest } from "../user-input/index.js";

/**
 * Happy carries agent-to-user questions on its own channel, separate from
 * permission requests: a permission gates something the agent wants to do, a
 * communication asks the user for something the agent does not know. The
 * payload's `kind` selects its shape, and a client that does not implement a
 * kind still shows the request and lets the user dismiss it. Rig asks the same
 * question shape from several tools (`AskUserQuestion`, Codex's
 * `request_user_input`, MCP elicitation), so every pending question is
 * published as the `form` kind regardless of its origin.
 */
const HAPPY_FORM_KIND = "form";
const MAX_COMPLETED_COMMUNICATIONS = 100;

export interface HappyCommunication {
    createdAt: number;
    form: unknown;
    kind: string;
    title: string;
    toolUseId: string;
}

export interface HappyResolvedCommunication {
    answers?: Record<string, unknown>;
    communication: HappyCommunication;
    completedAt: number;
    status: "answered" | "cancelled";
}

interface HappyAgentState {
    communications: Record<string, HappyCommunication>;
    completedCommunications: Record<string, unknown>;
}

/**
 * Keeps enough recent completions for Happy to settle a form that was answered
 * on another device without letting a months-long session grow this live-state
 * payload forever.
 */
export function rememberHappyResolvedCommunication(
    completed: Map<string, HappyResolvedCommunication>,
    requestId: string,
    resolved: HappyResolvedCommunication,
): void {
    completed.delete(requestId);
    completed.set(requestId, resolved);
    while (completed.size > MAX_COMPLETED_COMMUNICATIONS) {
        const oldestRequestId = completed.keys().next().value;
        if (oldestRequestId === undefined) return;
        completed.delete(oldestRequestId);
    }
}

/**
 * Projects Rig's pending questions into Happy's communication state. Happy
 * joins each entry onto its tool call by id, and Rig uses the tool call id as
 * the question's request id, so the two line up without extra bookkeeping.
 *
 * Returns null when there is nothing to publish, which clears the remote state.
 */
export function createHappyAgentState(options: {
    completed: ReadonlyMap<string, HappyResolvedCommunication>;
    /**
     * When the question was first seen. This has to stay stable across
     * publishes: the caller skips the round trip only when the serialized state
     * is byte-identical, so a moving timestamp republishes on every sync tick.
     */
    createdAt: (requestId: string) => number;
    pending: readonly UserInputRequest[];
}): HappyAgentState | null {
    const communications: Record<string, HappyCommunication> = {};
    for (const request of options.pending) {
        communications[request.requestId] = toHappyCommunication(
            request,
            options.createdAt(request.requestId),
        );
    }

    const completedCommunications: Record<string, unknown> = {};
    for (const [requestId, resolved] of options.completed) {
        // A question that is pending again takes precedence over a stale answer.
        if (communications[requestId] !== undefined) continue;
        completedCommunications[requestId] = {
            ...resolved.communication,
            completedAt: resolved.completedAt,
            status: resolved.status,
            ...(resolved.answers === undefined ? {} : { answers: resolved.answers }),
        };
    }

    if (
        Object.keys(communications).length === 0 &&
        Object.keys(completedCommunications).length === 0
    ) {
        return null;
    }
    return { communications, completedCommunications };
}

/**
 * Builds the `form` payload Happy renders. Every question also accepts an
 * answer the user writes themselves, because Rig takes any answer text and not
 * only the labels it offered.
 */
export function toHappyCommunication(
    request: UserInputRequest,
    createdAt: number,
): HappyCommunication {
    return {
        createdAt,
        form: {
            questions: request.questions.map((question) => ({
                allowCustom: true,
                header: question.header,
                id: question.id,
                multiSelect: question.multiSelect,
                options: question.options.map((option) => ({
                    description: option.description,
                    label: option.label,
                })),
                question: question.question,
                required: question.required !== false,
            })),
        },
        kind: HAPPY_FORM_KIND,
        // Shown by a client that cannot render this kind, so the user still
        // learns what the agent is waiting on.
        title: request.questions[0]?.header ?? "Question",
        toolUseId: request.requestId,
    };
}
