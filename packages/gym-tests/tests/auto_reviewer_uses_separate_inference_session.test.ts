import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Auto reviewer inference session isolation", () => {
    it("keeps the reviewer off the agent session while an approved tool completes", async () => {
        const gym = await createGym({
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            inference(request, callIndex) {
                if (request.context.systemPrompt?.includes("independent permission reviewer")) {
                    expect(callIndex).toBe(1);
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    decision: "allow",
                                    reason: "The user requested this harmless workspace marker.",
                                    risk: "low",
                                    user_authorization: "high",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    command: "printf 'isolated reviewer\\n' > reviewer-session.txt",
                                    dangerouslyDisableSandbox: true,
                                },
                                id: "isolated-reviewer-command",
                                name: "Bash",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                expect(callIndex).toBe(2);
                expect(request.context.messages.at(-1)).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "Bash",
                });
                return { content: [{ text: "REVIEWER_SESSION_ISOLATED", type: "text" }] };
            },
            modelId: "anthropic/sonnet-5",
            permissionMode: "auto",
            providerId: "claude",
            providerOverrides: ["claude"],
        });
        running.add(gym);

        gym.terminal.type("Create the harmless workspace marker.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("REVIEWER_SESSION_ISOLATED", 30_000);
        expect(screen.text).not.toContain("Allow once");
        await expect(gym.readFile("reviewer-session.txt")).resolves.toBe("isolated reviewer\n");

        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        const reviewer = requests.find((request) =>
            request.context.systemPrompt?.includes("independent permission reviewer"),
        );
        const agent = requests.filter(
            (request) => !request.context.systemPrompt?.includes("independent permission reviewer"),
        );
        expect(reviewer?.options.sessionId).toBeTypeOf("string");
        expect(agent).toHaveLength(2);
        expect(agent[0]?.options.sessionId).toBe(agent[1]?.options.sessionId);
        expect(reviewer?.options.sessionId).not.toBe(agent[0]?.options.sessionId);
    }, 60_000);
});
