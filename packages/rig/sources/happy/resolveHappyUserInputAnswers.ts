import type { UserInputRequest, UserInputResponse } from "../user-input/index.js";

/**
 * Happy answers a form with one entry per question id: the labels the user
 * picked, plus the answer they wrote themselves when they wrote one. Rig wants
 * a flat list of answer strings per question and accepts any answer text, not
 * only the labels it offered, so the two are folded together here.
 */
export function resolveHappyUserInputAnswers(
    request: UserInputRequest,
    answers: Record<string, unknown>,
): UserInputResponse {
    const resolved: Record<string, string[]> = {};
    for (const question of request.questions) {
        const selected = readAnswer(answers[question.id]);
        if (selected.length === 0) continue;
        resolved[question.id] = question.multiSelect ? selected : selected.slice(0, 1);
    }
    return { answers: resolved };
}

function readAnswer(value: unknown): string[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const { custom, options } = value as { custom?: unknown; options?: unknown };
    const labels = (Array.isArray(options) ? options : [])
        .filter((option): option is string => typeof option === "string")
        .map((option) => option.trim())
        .filter((option) => option !== "");
    const written = typeof custom === "string" ? custom.trim() : "";
    // A written answer that repeats an offered label would otherwise count
    // twice and break a single-select question's one-answer rule.
    if (written !== "" && !labels.includes(written)) labels.push(written);
    return labels;
}
