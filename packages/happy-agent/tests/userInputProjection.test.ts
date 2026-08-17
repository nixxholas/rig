import type { AgentEvent, UserInputRequest } from "@slopus/happy-agent-modules";
import { describe, expect, it } from "vitest";

import { projectSessionEvent } from "../sources/modules/http/sessionRoutes.js";
import {
    userInputAnswerForModule,
    userInputAnswersForProtocol,
    userInputRequestForProtocol,
} from "../sources/modules/http/userInputProtocol.js";

const SESSION_ID = "session-1";
const AGENT_ID = "agent-1";

const pending: UserInputRequest = {
    askingAgentId: AGENT_ID,
    context: "Two ways to finish the migration.",
    createdAt: 1_000,
    id: "call-1",
    options: {
        choices: [
            { description: "Rewrite the table.", label: "Rewrite" },
            { description: "Keep both tables.", label: "Keep both" },
        ],
        multiSelect: false,
    },
    question: "How should the migration finish?",
    status: "pending",
    updatedAt: 1_000,
};

function userInputEvent(payload: Record<string, unknown>): AgentEvent {
    return {
        agentId: AGENT_ID,
        id: "event-1",
        occurredAt: 2_000,
        payload,
        type: "user_input.event",
    };
}

describe("user input reaches a client and comes back", () => {
    it("shows a pending question as one answerable question", () => {
        expect(userInputRequestForProtocol(pending)).toEqual({
            questions: [
                {
                    header: "Question",
                    id: "call-1",
                    multiSelect: false,
                    options: [
                        { description: "Rewrite the table.", label: "Rewrite" },
                        { description: "Keep both tables.", label: "Keep both" },
                    ],
                    question: "How should the migration finish?",
                },
            ],
            requestId: "call-1",
        });
    });

    it("names every question of a batched request and reports its auto-resolution window", () => {
        const batched = userInputRequestForProtocol({
            ...pending,
            deadlineAt: 61_000,
            questions: [
                { header: "Scope", id: "q1", question: "Which folders?" },
                {
                    header: "Timing",
                    id: "q2",
                    options: {
                        choices: [{ description: "Right away.", label: "Now" }],
                        multiSelect: true,
                    },
                    question: "When?",
                },
            ],
        });
        expect(batched.autoResolutionMs).toBe(60_000);
        expect(batched.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
        expect(batched.questions[1]?.multiSelect).toBe(true);
    });

    it("reads a chosen label as a selection and anything else as typed text", () => {
        expect(userInputAnswerForModule(pending, { "call-1": ["Rewrite"] })).toEqual({
            answer: { selectedOptions: ["Rewrite"] },
            requestId: "call-1",
        });
        expect(
            userInputAnswerForModule(pending, { "call-1": ["Keep both", "but stage it"] }),
        ).toEqual({
            answer: { selectedOptions: ["Keep both"], text: "but stage it" },
            requestId: "call-1",
        });
        expect(
            userInputAnswerForModule(pending, { "call-1": ["something else entirely"] }),
        ).toEqual({
            answer: "something else entirely",
            requestId: "call-1",
        });
    });

    it("refuses an answer that says nothing", () => {
        expect(() => userInputAnswerForModule(pending, { "call-1": [] })).toThrow(
            /Answer "How should the migration finish\?"/,
        );
    });

    it("projects a new question so a client can render it", () => {
        expect(
            projectSessionEvent(
                userInputEvent({
                    actingAgentId: AGENT_ID,
                    at: 2_000,
                    eventId: "user-input-event-1",
                    request: pending,
                    requestId: "call-1",
                    type: "user_input_requested",
                }),
                SESSION_ID,
            ),
        ).toMatchObject({
            data: { requestId: "call-1" },
            sessionId: SESSION_ID,
            type: "user_input_requested",
        });
    });

    it("projects an answer with the values a person chose", () => {
        const answered: UserInputRequest = {
            ...pending,
            answer: { selectedOptions: ["Rewrite"], text: "and drop the old table" },
            answeredAt: 2_000,
            status: "answered",
            updatedAt: 2_000,
        };
        expect(userInputAnswersForProtocol(answered)).toEqual({
            "call-1": ["Rewrite", "and drop the old table"],
        });
        expect(
            projectSessionEvent(
                userInputEvent({
                    actingAgentId: AGENT_ID,
                    at: 2_000,
                    eventId: "user-input-event-2",
                    request: answered,
                    requestId: "call-1",
                    type: "user_input_answered",
                }),
                SESSION_ID,
            ),
        ).toMatchObject({
            data: {
                answers: { "call-1": ["Rewrite", "and drop the old table"] },
                requestId: "call-1",
                status: "answered",
            },
            type: "user_input_resolved",
        });
    });

    it("withdraws a question that timed out", () => {
        expect(
            projectSessionEvent(
                userInputEvent({
                    actingAgentId: AGENT_ID,
                    at: 3_000,
                    eventId: "user-input-event-3",
                    request: {
                        ...pending,
                        deadlineAt: 3_000,
                        status: "timed_out",
                        timedOutAt: 3_000,
                        updatedAt: 3_000,
                    },
                    requestId: "call-1",
                    type: "user_input_completed",
                }),
                SESSION_ID,
            ),
        ).toMatchObject({
            data: { requestId: "call-1", status: "cancelled" },
            type: "user_input_resolved",
        });
    });

    it("drops a recorded event that is not a user input event", () => {
        expect(projectSessionEvent(userInputEvent({ type: "something_else" }), SESSION_ID)).toBe(
            undefined,
        );
    });
});
