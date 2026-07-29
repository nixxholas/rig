import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("incomplete tool call at the output limit", () => {
    it("does not execute the partial call and closes it before the next user turn", async () => {
        const gym = await createGym({
            async inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "printf bad > should-not-exist.txt" },
                                id: "partial-command",
                                incomplete: true,
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                        stopReason: "length",
                    };
                }

                expect(callIndex).toBe(1);
                const assistantIndex = request.context.messages.findIndex(
                    (message) =>
                        message.role === "assistant" &&
                        message.content.some(
                            (content) =>
                                content.type === "toolCall" && content.incomplete === true,
                        ),
                );
                const resultIndex = request.context.messages.findIndex(
                    (message) => message.role === "toolResult" && message.isError,
                );
                const nextUserIndex = request.context.messages.findLastIndex(
                    (message) => message.role === "user",
                );
                expect(assistantIndex).toBeGreaterThanOrEqual(0);
                expect(resultIndex).toBe(assistantIndex + 1);
                expect(nextUserIndex).toBe(resultIndex + 1);
                return { content: [{ text: "INCOMPLETE_CALL_RECOVERED", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Start a command but run out of output.");
        await gym.terminal.waitForText("model reached its output limit", 30_000);
        await expect(gym.readFile("should-not-exist.txt")).rejects.toThrow();

        submit(gym, "Continue after the partial call.");
        const screen = await gym.terminal.waitForText("INCOMPLETE_CALL_RECOVERED", 30_000);
        expect(screen.text).toContain("INCOMPLETE_CALL_RECOVERED");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}