import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Claude foreground Bash steering", () => {
    it("interrupts a long Bash wait and continues the same run with the steering message", async () => {
        const gym = await createGym({
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            mode: "docker",
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
            providerOverrides: ["claude"],
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    command: "sleep 60",
                                    description: "Wait for a long time",
                                    timeout: 300_000,
                                },
                                id: "long-bash-wait",
                                name: "Bash",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(1);
                expect(request.context.messages.slice(-2)).toMatchObject([
                    {
                        isError: true,
                        role: "toolResult",
                        toolName: "Bash",
                    },
                    {
                        content: [{ text: "Change direction now.", type: "text" }],
                        role: "user",
                    },
                ]);
                return {
                    content: [{ text: "STEERING_CONTINUED_AFTER_BASH", type: "text" }],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("Start the long command.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Running sleep 60", 30_000);

        gym.terminal.type("Change direction now.");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitForText("STEERING_CONTINUED_AFTER_BASH", 10_000);
        expect(completed.text).toContain("Change direction now.");
    }, 60_000);
});
