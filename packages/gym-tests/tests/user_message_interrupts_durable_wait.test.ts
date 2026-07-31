import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("durable model waits", () => {
    it("shows waiting state and ends the wait when the user sends a message", async () => {
        const steering = "Stop waiting and continue now.";
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    expect(request.context.tools?.map((tool) => tool.name)).toEqual(
                        expect.arrayContaining(["wait", "wait_until", "schedule_message"]),
                    );
                    return {
                        content: [
                            {
                                arguments: { seconds: 60 },
                                id: "durable-wait-call",
                                name: "wait",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(1);
                const serialized = JSON.stringify(request.context.messages);
                expect(serialized).toContain(steering);
                expect(serialized).toContain(
                    "The wait ended early because a new message arrived after ",
                );
                expect(serialized).toContain(" seconds.");
                return { content: [{ text: "DURABLE_WAIT_INTERRUPTED", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Wait for one minute.");
        const waiting = await gym.terminal.waitForText("Waiting until", 30_000);
        expect(waiting.text).toContain("Ask Rig to do anything");

        submit(gym, steering);
        const completed = await gym.terminal.waitForText("DURABLE_WAIT_INTERRUPTED", 30_000);
        expect(completed.text).toContain(steering);
        expect(completed.text).toContain("Wait interrupted after");
        expect(completed.text).not.toContain("Waiting until");
    }, 90_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
