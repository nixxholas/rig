import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, frameEvent, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("a Happy agent installation outlives its process", () => {
    it("keeps the same chat and its history when the daemon is started again", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "Before the restart.", type: "text" }] },
                { content: [{ text: "After the restart.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("Remember this.");
        const sessionId = gym.defaultSessionId;
        const before = await gym.sessionEvents();

        await gym.restart();

        expect(gym.defaultSessionId).toBe(sessionId);
        const after = await gym.sessionEvents();
        expect(JSON.stringify(after)).toContain("Before the restart.");
        expect(after.length).toBeGreaterThanOrEqual(before.length);

        // The restarted installation still works.
        await gym.send("And now this.");
        expect(gym.inference.userTexts()).toContain("And now this.");
        expect(gym.errors).toEqual([]);
    });
});

describe("live events", () => {
    it("streams a turn to a subscriber that connected before it started", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Streaming answer.", type: "text" }] }],
        });
        running.add(gym);

        const stream = gym.stream("/v0/events/live");
        try {
            // Opening resolves on the response headers, before any frame has been read, so the
            // greeting is waited for rather than indexed.
            const hello = await stream.waitFor(
                (frame) => frame.event === "hello",
                "the live stream to greet its subscriber",
            );
            expect(stream.frames.indexOf(hello)).toBe(0);
            await gym.send("Stream this.");

            const settled = await stream.waitFor(
                (frame) => frameEvent(frame)?.type === "loop.settled",
                "the run to settle on the live stream",
            );
            expect(settled.event).toBe("update");
            expect(settled.id).toMatch(/^[0-9a-f-]{8}-/);
            expect(stream.frames.some((frame) => frame.raw.includes("Streaming answer."))).toBe(
                true,
            );
        } finally {
            stream.close();
        }
    });

    it("names each frame after the event type on the durable stream", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Durable answer.", type: "text" }] }],
        });
        running.add(gym);

        const stream = gym.stream("/v0/events/stream");
        try {
            await stream.opened();
            await gym.send("Stream this durably.");
            const settled = await stream.waitFor(
                (frame) => frame.event === "loop.settled",
                "the run to settle on the durable stream",
            );
            expect(frameEvent(settled)).toMatchObject({ type: "loop.settled" });
        } finally {
            stream.close();
        }
    });
});
