import { describe, expect, it } from "vitest";

import type { UserInputRequest } from "../../user-input/index.js";
import { resolveHappyUserInputAnswers } from "../resolveHappyUserInputAnswers.js";

function request(overrides?: Partial<UserInputRequest>): UserInputRequest {
    return {
        questions: [
            {
                header: "Storage",
                id: "question_1",
                multiSelect: false,
                options: [
                    { description: "Sync everywhere", label: "In settings" },
                    { description: "Device only", label: "Locally" },
                ],
                question: "Where should the order live?",
            },
        ],
        requestId: "call-1",
        ...overrides,
    };
}

describe("resolveHappyUserInputAnswers", () => {
    it("reads the labels Happy keyed by question id", () => {
        expect(
            resolveHappyUserInputAnswers(request(), {
                question_1: { options: ["Locally"] },
            }),
        ).toEqual({ answers: { question_1: ["Locally"] } });
    });

    it("keeps every label of a multi-select question", () => {
        const multi = request({
            questions: [{ ...request().questions[0]!, multiSelect: true }],
        });
        expect(
            resolveHappyUserInputAnswers(multi, {
                question_1: { options: ["In settings", "Locally"] },
            }),
        ).toEqual({ answers: { question_1: ["In settings", "Locally"] } });
    });

    it("keeps only the first label for a single-select question", () => {
        expect(
            resolveHappyUserInputAnswers(request(), {
                question_1: { options: ["In settings", "Locally"] },
            }),
        ).toEqual({ answers: { question_1: ["In settings"] } });
    });

    it("takes an answer the user wrote themselves", () => {
        expect(
            resolveHappyUserInputAnswers(request(), {
                question_1: { custom: "  In a database  ", options: [] },
            }),
        ).toEqual({ answers: { question_1: ["In a database"] } });
    });

    it("keeps a written answer alongside picked labels when several are allowed", () => {
        const multi = request({
            questions: [{ ...request().questions[0]!, multiSelect: true }],
        });
        expect(
            resolveHappyUserInputAnswers(multi, {
                question_1: { custom: "In a database", options: ["Locally"] },
            }),
        ).toEqual({ answers: { question_1: ["Locally", "In a database"] } });
    });

    it("does not count a written answer that repeats an offered label twice", () => {
        expect(
            resolveHappyUserInputAnswers(request(), {
                question_1: { custom: "Locally", options: ["Locally"] },
            }),
        ).toEqual({ answers: { question_1: ["Locally"] } });
    });

    it("skips questions Happy left unanswered", () => {
        expect(resolveHappyUserInputAnswers(request(), {})).toEqual({ answers: {} });
        expect(
            resolveHappyUserInputAnswers(request(), { question_1: { custom: "  ", options: [] } }),
        ).toEqual({ answers: {} });
    });
});
