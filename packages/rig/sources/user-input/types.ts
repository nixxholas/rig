import type { Presence } from "../presence/types.js";

export interface UserInputOption {
    description: string;
    label: string;
}

export interface UserInputQuestion {
    header: string;
    id: string;
    multiSelect: boolean;
    options: readonly UserInputOption[];
    question: string;
    required?: boolean;
}

export interface UserInputRequest {
    autoResolutionMs?: number;
    questions: readonly UserInputQuestion[];
    requestId: string;
}

export interface UserInputResponse {
    answers: Readonly<Record<string, readonly string[]>>;
}

/**
 * A question the user's presence stopped waiting for. The question itself stays in the Inbox,
 * so the agent either continues without an answer or withdraws it with `cancel_ask`.
 */
export interface UnansweredUserInput {
    askId: string;
    /** When the presence is expected to change, when that is known. */
    changesAt?: number;
    presence: Presence;
    reason: "away" | "timeout";
    status: "unanswered";
    waitedMs: number;
}

export type UserInputOutcome = ({ status: "answered" } & UserInputResponse) | UnansweredUserInput;
