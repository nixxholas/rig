import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

interface PendingUserInput {
    readonly requestId: string;
}

describe("a question the agent asked and the answer it got", () => {
    it("reaches the durable journal, so a client that was not watching can still see it", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                input: {
                                    context: "Deciding where the release notes should go.",
                                    header: "Notes",
                                    question: "Where should the release notes live?",
                                },
                            },
                            callId: "ask-1",
                            name: "request_user_input",
                            type: "tool_call",
                        },
                    ],
                },
                { content: [{ text: "Understood.", type: "text" }] },
            ],
        });
        running.add(gym);

        const acceptance = await gym.send("Ask me where the notes go.", { wait: false });
        const pending = await gym.waitUntil(async () => {
            const session = await gym.getSession();
            return (session.pendingUserInputs as readonly PendingUserInput[] | undefined)?.[0];
        }, "the pending question to reach the session");

        await gym.http.ok(
            "POST",
            `/v0/sessions/${gym.rootSessionId}/user-input/${pending.requestId}`,
            { answers: { [pending.requestId]: ["In the repository."] } },
        );
        await gym.waitForRun(acceptance.runId);

        // Journaling happens after the answer has been committed, which is a different lifetime
        // from the turn that asked; recording it on the finished turn's context wrote nothing.
        const journaled = (await gym.events()).filter((event) => event.type === "user-input.event");
        expect(journaled.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(journaled)).toContain("Where should the release notes live?");
        expect(JSON.stringify(journaled)).toContain("In the repository.");

        // And a client reading the chat sees the question asked and then resolved.
        const projected = (await gym.sessionEvents()).map((event) => event.type);
        expect(projected).toContain("user_input_requested");
        expect(projected).toContain("user_input_resolved");
    });
});
