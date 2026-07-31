import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("A command that leaves work running behind it", () => {
    it("does not take that work down when it exits", async () => {
        const marker = "DEV_SERVER_STILL_RUNNING";
        let observation = "";
        const gym = await createGym({
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            mode: "docker",
            inference(request, callIndex) {
                const lastMessage = request.context.messages.at(-1);
                const resultText =
                    typeof lastMessage?.content === "string"
                        ? lastMessage.content
                        : (lastMessage?.content ?? [])
                              .filter((block) => block.type === "text")
                              .map((block) => block.text)
                              .join("");

                if (callIndex === 0) {
                    // The launcher exits at once; the shell it spawned keeps
                    // writing. This is what a `npm run dev &` looks like.
                    return {
                        content: [
                            {
                                arguments: {
                                    command:
                                        "nohup sh -c 'sleep 2; printf %s \"$0\" > survivor.txt' " +
                                        `${marker} > /dev/null 2>&1 &\nprintf LAUNCHED`,
                                },
                                id: "launch-detached-child",
                                name: "Bash",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (callIndex === 1) {
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "Bash",
                    });
                    expect(resultText).toContain("LAUNCHED");
                    return {
                        content: [
                            {
                                arguments: {
                                    command: "sleep 4; cat survivor.txt 2>&1",
                                },
                                id: "look-for-the-survivor",
                                name: "Bash",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(2);
                observation = resultText;
                return { content: [{ text: "BACKGROUND_CHILD_CHECKED", type: "text" }] };
            },
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
            providerOverrides: ["claude"],
            timeoutMs: 60_000,
        });
        running.add(gym);

        gym.terminal.type("Start the background job, then check whether it is still running.");
        gym.terminal.press("enter");

        const settled = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("BACKGROUND_CHILD_CHECKED"),
            "the detached child to outlive the command that started it",
            60_000,
        );

        expect(settled.text).toContain("BACKGROUND_CHILD_CHECKED");
        expect(observation).toContain(marker);
        await expect(gym.readFile("survivor.txt")).resolves.toBe(marker);
    }, 90_000);
});
