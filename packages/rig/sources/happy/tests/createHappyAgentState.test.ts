import { describe, expect, it } from "vitest";

import type { UserInputRequest } from "../../user-input/index.js";
import {
    createHappyAgentState,
    rememberHappyResolvedCommunication,
    toHappyCommunication,
} from "../createHappyAgentState.js";

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

describe("createHappyAgentState", () => {
    it("publishes a pending question as a form communication", () => {
        const state = createHappyAgentState({
            completed: new Map(),
            createdAt: () => 5,
            pending: [request()],
        });

        expect(state).not.toBeNull();
        expect(state!.communications["call-1"]).toEqual({
            createdAt: 5,
            form: {
                questions: [
                    {
                        allowCustom: true,
                        header: "Storage",
                        id: "question_1",
                        multiSelect: false,
                        options: [
                            { description: "Sync everywhere", label: "In settings" },
                            { description: "Device only", label: "Locally" },
                        ],
                        question: "Where should the order live?",
                        required: true,
                    },
                ],
            },
            kind: "form",
            title: "Storage",
            toolUseId: "call-1",
        });
    });

    it("returns null when there is nothing to publish", () => {
        expect(
            createHappyAgentState({ completed: new Map(), createdAt: () => 5, pending: [] }),
        ).toBeNull();
    });

    it("reports answered questions as completed, with their answers", () => {
        const state = createHappyAgentState({
            completed: new Map([
                [
                    "call-1",
                    {
                        answers: { question_1: { options: ["Locally"] } },
                        communication: toHappyCommunication(request(), 1),
                        completedAt: 2,
                        status: "answered" as const,
                    },
                ],
            ]),
            createdAt: () => 5,
            pending: [],
        });

        expect(state!.completedCommunications["call-1"]).toMatchObject({
            answers: { question_1: { options: ["Locally"] } },
            completedAt: 2,
            createdAt: 1,
            kind: "form",
            status: "answered",
        });
        expect(state!.communications).toEqual({});
    });

    it("lets a re-asked question outrank its stale answer", () => {
        const state = createHappyAgentState({
            completed: new Map([
                [
                    "call-1",
                    {
                        communication: toHappyCommunication(request(), 1),
                        completedAt: 2,
                        status: "cancelled" as const,
                    },
                ],
            ]),
            createdAt: () => 5,
            pending: [request()],
        });

        expect(state!.communications["call-1"]).toBeDefined();
        expect(state!.completedCommunications["call-1"]).toBeUndefined();
    });

    it("bounds the completed question history", () => {
        const completed = new Map();
        for (let index = 0; index <= 100; index += 1) {
            rememberHappyResolvedCommunication(completed, `call-${String(index)}`, {
                communication: toHappyCommunication(request(), index),
                completedAt: index,
                status: "answered",
            });
        }

        expect(completed.size).toBe(100);
        expect(completed.has("call-0")).toBe(false);
        expect(completed.has("call-100")).toBe(true);
    });
});
