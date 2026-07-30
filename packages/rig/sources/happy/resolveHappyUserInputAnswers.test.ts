import { describe, expect, it } from "vitest";

import type { UserInputRequest } from "../user-input/index.js";
import { resolveHappyUserInputAnswers } from "./resolveHappyUserInputAnswers.js";
import {
    createHappyAgentState,
    rememberHappyResolvedRequest,
    toHappyArguments,
} from "./createHappyAgentState.js";

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
    it("keys answers by question id when Happy keys them by question text", () => {
        expect(
            resolveHappyUserInputAnswers(request(), {
                "Where should the order live?": "Locally",
            }),
        ).toEqual({ answers: { question_1: ["Locally"] } });
    });

    it("splits several labels for a multi-select question", () => {
        const multi = request({
            questions: [{ ...request().questions[0]!, multiSelect: true }],
        });
        expect(
            resolveHappyUserInputAnswers(multi, {
                "Where should the order live?": "In settings, Locally",
            }),
        ).toEqual({ answers: { question_1: ["In settings", "Locally"] } });
    });

    it("keeps only the first label for a single-select question", () => {
        expect(
            resolveHappyUserInputAnswers(request(), {
                "Where should the order live?": "In settings, Locally",
            }),
        ).toEqual({ answers: { question_1: ["In settings"] } });
    });

    it("recovers labels that themselves contain a comma", () => {
        const commas = request({
            questions: [
                {
                    header: "Scope",
                    id: "question_1",
                    multiSelect: true,
                    options: [
                        { description: "a", label: "Yes, always" },
                        { description: "b", label: "No, never" },
                    ],
                    question: "Confirm?",
                },
            ],
        });
        expect(
            resolveHappyUserInputAnswers(commas, { "Confirm?": "Yes, always, No, never" }),
        ).toEqual({ answers: { question_1: ["Yes, always", "No, never"] } });
    });

    it("also accepts answers keyed by question id or header", () => {
        expect(resolveHappyUserInputAnswers(request(), { question_1: "Locally" })).toEqual({
            answers: { question_1: ["Locally"] },
        });
        expect(resolveHappyUserInputAnswers(request(), { Storage: "Locally" })).toEqual({
            answers: { question_1: ["Locally"] },
        });
    });

    it("accepts an array of labels unchanged", () => {
        const multi = request({
            questions: [{ ...request().questions[0]!, multiSelect: true }],
        });
        expect(
            resolveHappyUserInputAnswers(multi, {
                "Where should the order live?": ["Locally", "In settings"],
            }),
        ).toEqual({ answers: { question_1: ["Locally", "In settings"] } });
    });

    it("drops answers that match no offered option", () => {
        expect(
            resolveHappyUserInputAnswers(request(), { "Where should the order live?": "Nowhere" }),
        ).toEqual({ answers: {} });
    });

    it("skips questions Happy left unanswered", () => {
        expect(resolveHappyUserInputAnswers(request(), {})).toEqual({ answers: {} });
    });
});

describe("createHappyAgentState", () => {
    it("publishes a pending question as an AskUserQuestion permission request", () => {
        const state = createHappyAgentState({
            completed: new Map(),
            createdAt: () => 5,
            pending: [request()],
        });

        expect(state).not.toBeNull();
        expect(state!.requests["call-1"]).toMatchObject({
            arguments: toHappyArguments(request()),
            tool: "AskUserQuestion",
        });
    });

    it("returns null when there is nothing to publish", () => {
        expect(
            createHappyAgentState({ completed: new Map(), createdAt: () => 5, pending: [] }),
        ).toBeNull();
    });

    it("reports answered questions as completed", () => {
        const state = createHappyAgentState({
            completed: new Map([
                [
                    "call-1",
                    {
                        arguments: toHappyArguments(request()),
                        completedAt: 2,
                        createdAt: 1,
                        status: "approved" as const,
                    },
                ],
            ]),
            createdAt: () => 5,
            pending: [],
        });

        expect(state!.completedRequests["call-1"]).toMatchObject({
            decision: "approved",
            status: "approved",
            tool: "AskUserQuestion",
        });
        expect(state!.requests).toEqual({});
    });

    it("lets a re-asked question outrank its stale answer", () => {
        const state = createHappyAgentState({
            completed: new Map([
                [
                    "call-1",
                    {
                        arguments: toHappyArguments(request()),
                        completedAt: 2,
                        createdAt: 1,
                        status: "approved" as const,
                    },
                ],
            ]),
            createdAt: () => 5,
            pending: [request()],
        });

        expect(state!.requests["call-1"]).toBeDefined();
        expect(state!.completedRequests["call-1"]).toBeUndefined();
    });

    it("bounds the completed question history", () => {
        const completed = new Map();
        for (let index = 0; index <= 100; index += 1) {
            rememberHappyResolvedRequest(completed, `call-${String(index)}`, {
                arguments: {},
                completedAt: index,
                createdAt: index,
                status: "approved",
            });
        }

        expect(completed.size).toBe(100);
        expect(completed.has("call-0")).toBe(false);
        expect(completed.has("call-100")).toBe(true);
    });
});
