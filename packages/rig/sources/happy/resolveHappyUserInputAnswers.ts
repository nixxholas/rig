import type { UserInputRequest, UserInputResponse } from "../user-input/index.js";

/**
 * Happy renders a question form and answers it with one string per question:
 * the chosen option labels joined by ", ", keyed by the question text it
 * displayed. Rig needs the answers keyed by question id with the labels split
 * back apart, so translate between the two here.
 */
export function resolveHappyUserInputAnswers(
    request: UserInputRequest,
    answers: Record<string, unknown>,
): UserInputResponse {
    const resolved: Record<string, string[]> = {};
    for (const question of request.questions) {
        const raw = answers[question.question] ?? answers[question.id] ?? answers[question.header];
        const labels = Array.isArray(raw)
            ? raw.filter((value): value is string => typeof value === "string")
            : typeof raw === "string"
              ? splitLabels(
                    raw,
                    question.options.map((option) => option.label),
                )
              : [];
        if (labels.length === 0) continue;
        resolved[question.id] = question.multiSelect ? labels : labels.slice(0, 1);
    }
    return { answers: resolved };
}

/**
 * Splits the joined labels by matching the question's own options longest-first
 * rather than splitting on commas, so an option label that itself contains
 * ", " survives the round trip. Falls back to a plain split when the greedy
 * match cannot consume the whole string.
 */
function splitLabels(value: string, labels: readonly string[]): string[] {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (labels.includes(trimmed)) return [trimmed];

    const ordered = [...labels]
        .filter((label) => label.length > 0)
        .sort((a, b) => b.length - a.length);
    const matched: string[] = [];
    let rest = trimmed;
    while (rest.length > 0) {
        const match = ordered.find((label) => rest.startsWith(label));
        if (match === undefined) break;
        matched.push(match);
        rest = rest.slice(match.length).replace(/^\s*,\s*/u, "");
    }
    if (rest.length === 0 && matched.length > 0) return matched;

    return trimmed.split(/\s*,\s*/u).filter((part) => labels.includes(part));
}
