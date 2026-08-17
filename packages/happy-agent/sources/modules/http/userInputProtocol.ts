import type {
    UserInputAnswer,
    UserInputAnswerInput,
    UserInputRequest,
} from "@slopus/happy-agent-modules";

/** One question in the shape a client renders it. */
interface ProtocolUserInputQuestion {
    readonly header: string;
    readonly id: string;
    readonly multiSelect: boolean;
    readonly options: readonly { readonly description: string; readonly label: string }[];
    readonly question: string;
}

interface ProtocolUserInputRequest {
    readonly autoResolutionMs?: number;
    readonly questions: readonly ProtocolUserInputQuestion[];
    readonly requestId: string;
}

/**
 * The pending question a client shows, built from the module's stored request.
 *
 * A single-question request has no question list of its own, so the request's own identity names
 * it; that is the identity the answer comes back under. A batched request already names each
 * question, and the client walks them in order.
 */
export function userInputRequestForProtocol(request: UserInputRequest): ProtocolUserInputRequest {
    const questions = request.questions ?? [
        {
            id: request.id,
            question: request.question,
            ...(request.header === undefined ? {} : { header: request.header }),
            ...(request.options === undefined ? {} : { options: request.options }),
        },
    ];
    return {
        ...(request.deadlineAt === undefined
            ? {}
            : { autoResolutionMs: Math.max(0, request.deadlineAt - request.createdAt) }),
        questions: questions.map((question) => ({
            header: question.header ?? "Question",
            id: question.id,
            multiSelect: question.options?.multiSelect ?? false,
            options: question.options?.choices ?? [],
            question: question.question,
        })),
        requestId: request.id,
    };
}

/**
 * The module answer a person's selections mean.
 *
 * A client sends the visible answer values for each question. A value that matches one of the
 * question's own choices is a selection; anything else is what the person typed. Keeping both
 * apart is what lets the module validate selections against the choices it offered while still
 * carrying free-form text through untouched.
 */
export function userInputAnswerForModule(
    request: UserInputRequest,
    answers: Readonly<Record<string, readonly string[]>>,
): UserInputAnswerInput {
    if (request.questions === undefined) {
        const values = answers[request.id] ?? Object.values(answers)[0] ?? [];
        return {
            answer: moduleAnswer(request.question, request.options?.choices, values),
            requestId: request.id,
        };
    }
    const answered: Record<string, UserInputAnswer> = {};
    for (const question of request.questions) {
        const values = answers[question.id];
        if (values === undefined || values.length === 0) continue;
        answered[question.id] = moduleAnswer(question.question, question.options?.choices, values);
    }
    if (Object.keys(answered).length === 0) {
        throw new Error("Answer at least one question before continuing.");
    }
    return { answers: answered, requestId: request.id };
}

/**
 * The stored answer in the shape a client reads it back.
 *
 * A client that answered already knows what it sent; this is for every other client watching the
 * same session, which learns the outcome only from the event stream.
 */
export function userInputAnswersForProtocol(
    request: UserInputRequest,
): Record<string, readonly string[]> {
    if (request.status !== "answered") return {};
    if (request.answers !== undefined) {
        return Object.fromEntries(
            Object.entries(request.answers).map(([id, answer]) => [id, answerValues(answer)]),
        );
    }
    return { [request.id]: answerValues(request.answer) };
}

function answerValues(answer: UserInputAnswer): readonly string[] {
    if (typeof answer === "string") return [answer];
    return [...(answer.selectedOptions ?? []), ...(answer.text === undefined ? [] : [answer.text])];
}

function moduleAnswer(
    question: string,
    choices: readonly { readonly label: string }[] | undefined,
    values: readonly string[],
): UserInputAnswer {
    const labels = new Set((choices ?? []).map((choice) => choice.label));
    const selectedOptions = values.filter((value) => labels.has(value));
    const text = values
        .filter((value) => !labels.has(value))
        .join("\n")
        .trim();
    if (selectedOptions.length === 0) {
        if (text.length === 0) throw new Error(`Answer "${question}" before continuing.`);
        return text;
    }
    return { selectedOptions, ...(text.length === 0 ? {} : { text }) };
}
