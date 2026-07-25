import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("session blocked for user input chimes", () => {
    it("chimes when the question tool waits for an answer", async () => {
        const gym = await createGym({
            homeFiles: {
                ".rig/config.toml": "[settings]\ncompletion_chime = true\n",
            },
            inference: [
                {
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
                                            {
                                                description: "Keep local setup lightweight.",
                                                label: "SQLite",
                                            },
                                        ],
                                        question: "Which database should this service use?",
                                    },
                                ],
                            },
                            id: "question-chime",
                            name: "request_user_input",
                            type: "toolCall",
                        },
                    ],
                },
            ],
        });
        running.add(gym);
        let rawOutput = "";
        gym.terminal.onOutput((data) => {
            rawOutput += data;
        });

        submit(gym, "Choose a database.");
        await gym.terminal.waitForText("Which database should this service use?");

        expect(standaloneBellCount(rawOutput)).toBe(1);
    }, 120_000);
});

function standaloneBellCount(output: string): number {
    let bells = 0;
    let inOsc = false;
    for (let index = 0; index < output.length; index += 1) {
        const character = output[index];
        if (character === "\x1b" && output[index + 1] === "]") {
            inOsc = true;
            index += 1;
            continue;
        }
        if (character === "\x07") {
            if (!inOsc) bells += 1;
            inOsc = false;
            continue;
        }
        if (inOsc && character === "\x1b" && output[index + 1] === "\\") {
            inOsc = false;
            index += 1;
        }
    }
    return bells;
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
