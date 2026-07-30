import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("manual conversation compaction", () => {
    it("finishes its own turn and leaves the session ready for the next user turn", async () => {
        const gym = await createGym({
            inference(request, callIndex) {
                const context = JSON.stringify(request.context.messages);
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                text: `MANUAL_COMPACTION_SOURCE\n${"important context ".repeat(12)}`,
                                type: "text",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    expect(request.options.intent).toBe("compaction");
                    return {
                        compactionContext: {
                            ...request.context,
                            messages: [
                                {
                                    role: "user",
                                    content: "MANUAL_COMPACTION_SUMMARY",
                                    timestamp: 1,
                                },
                            ],
                        },
                        content: [],
                    };
                }
                expect(callIndex).toBe(2);
                expect(context).toContain("MANUAL_COMPACTION_SUMMARY");
                return {
                    content: [{ text: "TURN_AFTER_MANUAL_COMPACTION", type: "text" }],
                };
            },
        });
        running.add(gym);

        submit(gym, "Build enough context for a manual compaction.");
        await gym.terminal.waitForText("MANUAL_COMPACTION_SOURCE", 30_000);

        submit(gym, "/compact");
        const compacted = await gym.terminal.waitForText("Context compacted", 30_000);
        expect(compacted.text).toContain("Ask Rig to do anything");

        submit(gym, "Continue after the manual compaction.");
        const continued = await gym.terminal.waitForText(
            "TURN_AFTER_MANUAL_COMPACTION",
            30_000,
        );
        expect(continued.text).toContain("Context compacted");
        expect(continued.text).toContain("Ask Rig to do anything");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}