import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("first-message naming", () => {
    it("accepts and starts the first turn while naming is still running", async () => {
        let releaseNaming!: () => void;
        const namingMayFinish = new Promise<void>((resolve) => {
            releaseNaming = resolve;
        });
        const gym = await createAgentGym({
            inference: async (request) => {
                if (request.instructions.includes("You name a piece of work")) {
                    await namingMayFinish;
                    return {
                        content: [
                            {
                                text: "<title>Project file list investigation</title>",
                                type: "text",
                            },
                        ],
                    };
                }
                return { content: [{ text: "Investigation complete.", type: "text" }] };
            },
        });
        activeGyms.add(gym);

        let acceptance: Awaited<ReturnType<AgentGym["send"]>> | undefined;
        const sending = gym
            .send("Investigate why the project file list is empty.", { wait: false })
            .then((accepted) => {
                acceptance = accepted;
                return accepted;
            });

        try {
            await gym.waitUntil(
                () =>
                    gym.inference.requests.some((request) =>
                        request.instructions.includes("You name a piece of work"),
                    )
                        ? true
                        : undefined,
                "title generation to start",
            );
            await gym.waitUntil(
                () => acceptance,
                "the first message to be accepted while title generation is still running",
                2_000,
            );
            await gym.waitUntil(
                () =>
                    gym.inference.requests.some(
                        (request) => !request.instructions.includes("You name a piece of work"),
                    )
                        ? true
                        : undefined,
                "the first real inference to start while title generation is still running",
                2_000,
            );
            expect(gym.inference.requests).toHaveLength(2);
        } finally {
            releaseNaming();
        }

        const accepted = await sending;
        await gym.waitForRun(accepted.runId);
        expect(gym.inference.requests).toHaveLength(2);
    }, 30_000);

    it("names an untitled session from its first message", async () => {
        const gym = await startGym();

        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.title).toBeNull();

        await gym.send("Investigate why the project file list is empty.");

        const named = await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            return agent.title === null ? undefined : agent;
        }, "the first message to name its session");
        expect(named.title).toBe("Project file list investigation");

        const requests = gym.inference.requests;
        const naming = requests.find((request) =>
            request.instructions.includes("You name a piece of work"),
        );
        expect(naming).toBeDefined();
        const namingPrompt = JSON.stringify(naming?.messages);
        expect(namingPrompt).toContain("Investigate why the project file list is empty.");
        expect(namingPrompt).not.toContain("Investigation complete.");
        expect(
            requests.some((request) =>
                JSON.stringify(request.messages).includes(
                    "Investigate why the project file list is empty.",
                ),
            ),
        ).toBe(true);
    }, 30_000);

    it("refines once from history including the second user message", async () => {
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.instructions.includes("You name a piece of work")) {
                    return {
                        content: [
                            {
                                text: "<title>Project file list investigation</title>",
                                type: "text",
                            },
                        ],
                    };
                }
                if (request.instructions.includes("saved chat that already has a title")) {
                    return {
                        content: [
                            {
                                text: "<title>Project file list repair</title>",
                                type: "text",
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            text: JSON.stringify(request.messages).includes(
                                "Actually fix the project file list instead.",
                            )
                                ? "Repair complete."
                                : "Investigation complete.",
                            type: "text",
                        },
                    ],
                };
            },
        });
        activeGyms.add(gym);

        await gym.send("Investigate why the project file list is empty.");
        await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            return agent.title === "Project file list investigation" ? true : undefined;
        }, "the first user message to set the initial title");

        await gym.send("Actually fix the project file list instead.");
        await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            return agent.title === "Project file list repair" ? true : undefined;
        }, "the second user message to refine the title");

        const refinement = gym.inference.requests.find((request) =>
            request.instructions.includes("saved chat that already has a title"),
        );
        expect(refinement).toBeDefined();
        const prompt = JSON.stringify(refinement?.messages);
        expect(prompt).toContain("Investigate why the project file list is empty.");
        expect(prompt).toContain("Investigation complete.");
        expect(prompt).toContain("Actually fix the project file list instead.");
        expect(prompt).not.toContain("Repair complete.");

        await gym.send("Run the focused tests too.");
        expect(
            gym.inference.requests.filter((request) =>
                request.instructions.includes("saved chat that already has a title"),
            ),
        ).toHaveLength(1);
    }, 30_000);
});

async function startGym(): Promise<AgentGym> {
    const gym = await createAgentGym({
        inference: (request) => {
            if (request.instructions.includes("You name a piece of work")) {
                return {
                    content: [
                        {
                            text: [
                                "<title>Project file list investigation</title>",
                                "<slug>project-file-list</slug>",
                            ].join("\n"),
                            type: "text",
                        },
                    ],
                };
            }
            return { content: [{ text: "Investigation complete.", type: "text" }] };
        },
    });
    activeGyms.add(gym);
    return gym;
}
