import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym, type GymMockResponse } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const askForDatabase: GymMockResponse = {
    content: [
        {
            arguments: {
                questions: [
                    {
                        header: "Database",
                        id: "database",
                        options: [
                            {
                                description: "Use the existing relational stack.",
                                label: "PostgreSQL",
                            },
                            { description: "Keep local setup lightweight.", label: "SQLite" },
                        ],
                        question: "Which database should this service use?",
                    },
                ],
            },
            id: "question-1",
            name: "request_user_input",
            type: "toolCall",
        },
    ],
};

describe("presence decides whether a question blocks the agent", () => {
    it("keeps working when the user has said they are away", async () => {
        const gym = await createGym({
            inference: [
                askForDatabase,
                { content: [{ text: "Chose SQLite alone.", type: "text" }] },
            ],
        });
        running.add(gym);

        gym.terminal.type("/presence");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Where are you?");
        gym.terminal.press("down");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("You are now Away.");

        gym.terminal.type("Choose a database.");
        gym.terminal.press("enter");

        // Nobody answers: the agent is told the user is away and finishes on its own.
        await gym.terminal.waitForText("Chose SQLite alone.");
        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        const toolResult = JSON.stringify(agentRequests[1]?.context.messages.at(-1));
        expect(toolResult).toContain("the user is Away");
        expect(toolResult).toContain("cancel_ask");
    });
});
