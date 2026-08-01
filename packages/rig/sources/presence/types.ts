/** One presence state the user can be in. Defined in configuration or built in. */
export interface Presence {
    /** How long a question may wait for an answer. `null` waits indefinitely, `0` never waits. */
    answerWaitMs: number | null;
    emoji: string;
    id: string;
    /** Model-facing description of what this state means for reaching the user. */
    prompt: string;
    title: string;
}

/** The presence the user is in right now, together with everything they could switch to. */
export interface PresenceState {
    /** When the current presence expires and the fallback takes over, when that is known. */
    changesAt?: number;
    fallbackPresenceId?: string;
    presence: Presence;
    presences: readonly Presence[];
    since: number;
}

export interface SetPresenceRequest {
    /** Presence to return to when this one expires. Defaults to Online. */
    fallbackPresenceId?: string;
    presenceId: string;
    /** Expiry time in milliseconds since the epoch. Omitted means the presence stays until changed. */
    until?: number;
}

/** How a presence decided the fate of a question that was waiting for the user. */
export type PresenceAnswerOutcome = "answered" | "away" | "timeout";
