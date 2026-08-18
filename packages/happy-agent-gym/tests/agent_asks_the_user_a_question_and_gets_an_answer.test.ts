import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

interface PendingUserInputQuestion {
    readonly header: string;
    readonly id: string;
    readonly multiSelect: boolean;
    readonly options: readonly { readonly description: string; readonly label: string }[];
    readonly question: string;
}

interface PendingUserInput {
    readonly questions: readonly PendingUserInputQuestion[];
    readonly requestId: string;
}

async function pendingQuestion(gym: AgentGym): Promise<PendingUserInput> {
    return await gym.waitUntil(async () => {
        const session = await gym.getSession();
        const pending = session.pendingUserInputs as readonly PendingUserInput[] | undefined;
        return pending?.[0];
    }, "the pending question to reach the session");
}

describe("the agent asks the user a question and gets an answer", () => {
    it("shows the model's exact question, header, and options to a client over HTTP", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                input: {
                                    context:
                                        "Evaluating storage options for the new service before we commit.",
                                    header: "DB",
                                    options: {
                                        choices: [
                                            {
                                                description: "Relational, strong consistency.",
                                                label: "Postgres",
                                            },
                                            {
                                                description: "Document store, flexible schema.",
                                                label: "Mongo",
                                            },
                                        ],
                                        multiSelect: false,
                                    },
                                    question: "Which database should we use for the new service?",
                                },
                            },
                            callId: "ask-1",
                            name: "request_user_input",
                            type: "tool_call",
                        },
                    ],
                },
                { content: [{ text: "Great, going with Postgres.", type: "text" }] },
            ],
        });
        running.add(gym);

        const acceptance = await gym.send("Help me pick a database.", { wait: false });

        const pending = await pendingQuestion(gym);
        expect(pending).toEqual({
            questions: [
                {
                    header: "DB",
                    id: "ask-1",
                    multiSelect: false,
                    options: [
                        { description: "Relational, strong consistency.", label: "Postgres" },
                        { description: "Document store, flexible schema.", label: "Mongo" },
                    ],
                    question: "Which database should we use for the new service?",
                },
            ],
            requestId: "ask-1",
        });

        // Answer it so the daemon has nothing left waiting when this scenario disposes it.
        await gym.http.ok("POST", `/v0/sessions/${gym.defaultSessionId}/user-input/ask-1`, {
            answers: { "ask-1": ["Postgres"] },
        });
        await gym.waitForRun(acceptance.runId);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("delivers the client's answer to the model as a tool result, and the turn finishes normally", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                input: {
                                    context: "Nobody has said which day works.",
                                    question: "Should we ship on Friday?",
                                },
                            },
                            callId: "ask-1",
                            name: "request_user_input",
                            type: "tool_call",
                        },
                    ],
                },
                { content: [{ text: "Shipping on Friday, understood.", type: "text" }] },
            ],
        });
        running.add(gym);

        const acceptance = await gym.send("Ask the human when to ship.", { wait: false });
        await pendingQuestion(gym);

        const answered = await gym.http.ok<{ readonly request: { readonly answer: unknown } }>(
            "POST",
            `/v0/sessions/${gym.defaultSessionId}/user-input/ask-1`,
            { answers: { "ask-1": ["Yes, ship on Friday, the team is ready."] } },
        );
        expect(answered.request.answer).toBe("Yes, ship on Friday, the team is ready.");

        const settled = await gym.waitForRun(acceptance.runId);
        expect(settled.payload).toMatchObject({ stopReason: "stop" });

        // The scripted model's second turn is the actual inference request the answer produced.
        expect(gym.inference.requests).toHaveLength(2);
        const continuation = gym.inference.requests[1];
        const toolResult = continuation?.messages.find(
            (message) => message.role === "tool" && message.callId === "ask-1",
        );
        expect(toolResult).toBeDefined();
        expect(toolResult?.role).toBe("tool");
        if (toolResult?.role === "tool") {
            const text = toolResult.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("");
            expect(text).toContain("Yes, ship on Friday, the team is ready.");
            expect(text).toContain("Answered");
        }

        expect(JSON.stringify(await gym.sessionEvents())).toContain(
            "Shipping on Friday, understood.",
        );
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("rejects an answer to a question nobody asked", async () => {
        const gym = await createAgentGym({});
        running.add(gym);

        const response = await gym.http.post(
            `/v0/sessions/${gym.defaultSessionId}/user-input/does-not-exist`,
            { answers: { "does-not-exist": ["Sure"] } },
        );

        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({
            error: 'Question "does-not-exist" was not found.',
        });
    });

    it("answering an already-answered question is a no-op that keeps the first answer", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                input: {
                                    context: "Only one of these can be picked.",
                                    options: {
                                        choices: [
                                            { description: "Ship now.", label: "Yes" },
                                            { description: "Wait a week.", label: "No" },
                                        ],
                                        multiSelect: false,
                                    },
                                    question: "Should we ship on Friday?",
                                },
                            },
                            callId: "ask-1",
                            name: "request_user_input",
                            type: "tool_call",
                        },
                    ],
                },
                { content: [{ text: "Shipping Friday.", type: "text" }] },
            ],
        });
        running.add(gym);

        const acceptance = await gym.send("Ask the human when to ship.", { wait: false });
        await pendingQuestion(gym);

        const firstAnswer = await gym.http.ok<{
            readonly request: { readonly answer: unknown; readonly status: string };
        }>("POST", `/v0/sessions/${gym.defaultSessionId}/user-input/ask-1`, {
            answers: { "ask-1": ["Yes"] },
        });
        expect(firstAnswer.request.answer).toEqual({ selectedOptions: ["Yes"] });
        await gym.waitForRun(acceptance.runId);

        // A second answer to the same, already-terminal request is accepted but changes nothing.
        const secondAnswer = await gym.http.ok<{
            readonly request: { readonly answer: unknown; readonly status: string };
        }>("POST", `/v0/sessions/${gym.defaultSessionId}/user-input/ask-1`, {
            answers: { "ask-1": ["No"] },
        });
        expect(secondAnswer.request.answer).toEqual({ selectedOptions: ["Yes"] });
        expect(secondAnswer.request.status).toBe("answered");

        expect(gym.errors).toEqual([]);
    });
});
