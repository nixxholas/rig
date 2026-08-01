import type { Presence } from "./types.js";

export interface UnansweredQuestionDescription {
    /** Identifier the model passes to `cancel_ask` to withdraw the question. */
    askId: string;
    /** When the presence is expected to change, when that is known. */
    changesAt?: number;
    now: number;
    presence: Presence;
    reason: "away" | "timeout";
    waitedMs: number;
}

/** The text an ask tool returns to the model when presence ended the wait instead of the user. */
export function describeUnansweredQuestion(description: UnansweredQuestionDescription): string {
    const { askId, changesAt, now, presence, reason, waitedMs } = description;
    const opening =
        reason === "away"
            ? `The question was not asked interactively because the user is ${presence.title} ${presence.emoji}.`
            : `Nobody answered within ${formatDuration(waitedMs)}, and the user is ${presence.title} ${presence.emoji}.`;
    const sentences = [opening];
    if (presence.prompt.trim().length > 0) sentences.push(presence.prompt.trim());
    if (changesAt !== undefined && changesAt > now) {
        sentences.push(
            `The user expects to change this state in about ${formatDuration(changesAt - now)}.`,
        );
    }
    sentences.push(
        `The question is waiting in the user's inbox as ask ${askId}; call cancel_ask with that id if you no longer need an answer.`,
        "Continue on your own with your best judgement.",
    );
    return sentences.join(" ");
}

function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1_000));
    if (seconds < 90) return plural(seconds, "second");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return plural(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return plural(hours, "hour");
    return plural(Math.round(hours / 24), "day");
}

function plural(count: number, unit: string): string {
    return `${String(count)} ${unit}${count === 1 ? "" : "s"}`;
}
