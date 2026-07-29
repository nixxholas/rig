import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("automatic compaction inside one user turn", () => {
    it("compacts after a closed tool batch and continues the same run", async () => {
        let sawCompaction = false;
        let compactionCount = 0;
        let regularInference = 0;
        const gym = await createGym({
            contextWindow: 500,
            async inference(request) {
                if (request.options.intent === "compaction") {
                    sawCompaction = true;
                    compactionCount += 1;
                    const calls = request.context.messages.filter(
                        (message) => message.role === "assistant",
                    );
                    const results = request.context.messages.filter(
                        (message) => message.role === "toolResult",
                    );
                    expect(calls).toHaveLength(1);
                    expect(results).toHaveLength(1);
                    if (compactionCount === 2) {
                        expect(JSON.stringify(results)).toContain("SECOND_BATCH_CLOSED");
                    }
                    return {
                        content: [
                            {
                                text:
                                    compactionCount === 1
                                        ? "Provider replacement context for the active turn."
                                        : "Provider replacement after the second tool batch.",
                                type: "text",
                            },
                        ],
                    };
                }

                if (regularInference++ === 0) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "printf 'TOOL_BATCH_CLOSED\\n'" },
                                id: "same-turn-tool",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                        usage: usage(400, 50),
                    };
                }

                expect(sawCompaction).toBe(true);
                expect(request.context.messages).toHaveLength(1);
                expect(JSON.stringify(request.context.messages[0])).toContain(
                    compactionCount === 1
                        ? "Provider replacement context for the active turn."
                        : "Provider replacement after the second tool batch.",
                );
                if (regularInference === 2) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "printf 'SECOND_BATCH_CLOSED\\n'" },
                                id: "post-compaction-tool",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                expect(JSON.stringify(request.context.messages)).toContain(
                    compactionCount === 1
                        ? "SECOND_BATCH_CLOSED"
                        : "Provider replacement after the second tool batch.",
                );
                return { content: [{ text: "SAME_TURN_COMPACTION_CONTINUED", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Complete several tool iterations without ending this turn.");
        const screen = await gym.terminal.waitForText(
            "SAME_TURN_COMPACTION_CONTINUED",
            30_000,
        );
        expect(screen.text).toContain("Context compacted");
        expect(screen.text).toContain("TOOL_BATCH_CLOSED");
        expect(screen.text).toContain("SECOND_BATCH_CLOSED");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function usage(input: number, output: number) {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input,
        output,
        totalTokens: input + output,
    };
}