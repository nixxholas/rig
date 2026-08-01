import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("finite question waits across a daemon restart", () => {
    it("continues the original run when the remaining presence wait expires", async () => {
        const gym = await createGym({
            entrypoint: [
                "bash",
                "-lc",
                [
                    "node /app/packages/rig/dist/main.js",
                    "node /app/packages/rig/dist/main.js daemon start",
                    "exec node /app/packages/rig/dist/main.js resume --last",
                ].join("; "),
            ],
            homeFiles: {
                "happy/config/happy.toml": [
                    "[presence]",
                    'current = "briefly-away"',
                    "",
                    "[presence.states.briefly-away]",
                    'title = "Briefly away"',
                    'emoji = "⏳"',
                    'prompt = "Continue when the answer window expires."',
                    'answer_wait = "3 seconds"',
                    "",
                ].join("\n"),
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
                                                description: "Use PostgreSQL.",
                                                label: "PostgreSQL",
                                            },
                                            {
                                                description: "Use SQLite.",
                                                label: "SQLite",
                                            },
                                        ],
                                        question: "Which database should the service use?",
                                    },
                                ],
                            },
                            id: "restart-timeout-question",
                            name: "request_user_input",
                            type: "toolCall",
                        },
                    ],
                },
                {
                    content: [{ text: "PRESENCE_TIMEOUT_RESUMED", type: "text" }],
                },
            ],
            mode: "docker",
        });
        running.add(gym);

        gym.terminal.type("Choose a database, but continue when my wait expires.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Which database should the service use?", 30_000);

        await gym.runInContainer("node", ["/app/packages/rig/dist/main.js", "daemon", "stop"]);
        await gym.runInContainer(
            "sh",
            [
                "-c",
                "while node /app/packages/rig/dist/main.js daemon status | grep -q 'Daemon is running'; do sleep 0.05; done",
            ],
            { timeoutMs: 30_000 },
        );
        await gym.runInContainer("node", ["/app/packages/rig/dist/main.js", "daemon", "start"]);

        const completed = await gym.terminal.waitForText("PRESENCE_TIMEOUT_RESUMED", 30_000);
        expect(completed.text).toContain("PRESENCE_TIMEOUT_RESUMED");
        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(JSON.stringify(requests[1]?.context.messages.at(-1))).toContain(
            "Nobody answered within",
        );
    }, 120_000);
});
