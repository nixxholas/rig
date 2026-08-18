import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("a client that reconnects to the durable event stream", () => {
    it("replays the turn that ran while it was away, and keeps streaming afterwards", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "Before the disconnect.", type: "text" }] },
                { content: [{ text: "While you were away.", type: "text" }] },
                { content: [{ text: "Back on the wire.", type: "text" }] },
            ],
        });
        running.add(gym);

        let missedFrom = "";
        const before = gym.stream("/v0/events/stream");
        try {
            await before.opened();
            await gym.send("Talk to me.");
            const settled = await before.waitFor(
                (frame) => frame.event === "loop.settled",
                "the first run to settle",
            );
            missedFrom = settled.id ?? "";
        } finally {
            before.close();
        }
        expect(missedFrom).toMatch(/^[0-9a-f]{8}-/);

        await gym.send("Answer this while I am gone.");

        // A reconnecting client names the last id it saw, exactly as an EventSource does.
        const resumed = gym.stream("/v0/events/stream", { lastEventId: missedFrom });
        try {
            const hello = await resumed.waitFor(
                (frame) => frame.event === "hello",
                "the resumed stream to greet its client",
            );
            expect(hello.data).toMatchObject({ gap: false, resumed: true });

            await resumed.waitFor(
                (frame) => frame.event === "loop.settled",
                "the missed run to be replayed",
            );
            const replayed = resumed.frames;
            expect(replayed.some((frame) => frame.raw.includes("While you were away."))).toBe(true);
            expect(
                replayed.some((frame) => frame.raw.includes("Answer this while I am gone.")),
            ).toBe(true);

            // Nothing the client already had comes back, not even the event it resumed from.
            expect(replayed.some((frame) => frame.raw.includes("Before the disconnect."))).toBe(
                false,
            );
            expect(replayed.some((frame) => frame.id === missedFrom)).toBe(false);
            const ids = replayed.flatMap((frame) => (frame.id === undefined ? [] : [frame.id]));
            expect(new Set(ids).size).toBe(ids.length);
            expect([...ids].sort()).toEqual(ids);

            // The replay handed over to a live subscription rather than ending with it.
            await gym.send("And now live again.");
            await resumed.waitFor(
                (frame) => frame.raw.includes("Back on the wire."),
                "the next turn to arrive live",
            );
        } finally {
            resumed.close();
        }
        expect(gym.inference.unscripted).toEqual([]);
    });
});

describe("a client that reconnects to one chat's stream", () => {
    it("replays only that chat's missed events while another chat was also working", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "Root replied first.", type: "text" }] },
                { content: [{ text: "The other chat replied.", type: "text" }] },
                { content: [{ text: "Root replied again.", type: "text" }] },
            ],
        });
        running.add(gym);
        const other = await gym.createSession();

        let missedFrom = "";
        const before = gym.stream(`/v0/sessions/${gym.rootSessionId}/stream`);
        try {
            await before.opened();
            await gym.send("Root, first.");
            const finished = await before.waitFor(
                (frame) => frame.event === "run_finished",
                "the first root run to finish",
            );
            missedFrom = finished.id ?? "";
        } finally {
            before.close();
        }
        expect(missedFrom).toMatch(/^[0-9a-f]{8}-/);

        // Both chats work while nobody is listening, in a fixed order the script decides.
        await gym.send("Other, while nobody watched.", { sessionId: other.id });
        await gym.send("Root, while nobody watched.");

        const resumed = gym.stream(`/v0/sessions/${gym.rootSessionId}/stream`, {
            lastEventId: missedFrom,
        });
        try {
            const hello = await resumed.waitFor(
                (frame) => frame.event === "hello",
                "the resumed chat stream to greet its client",
            );
            expect(hello.data).toMatchObject({ resumed: true, sessionId: gym.rootSessionId });

            await resumed.waitFor(
                (frame) => frame.event === "run_finished",
                "the missed root run to be replayed",
            );
            const text = resumed.frames.map((frame) => frame.raw).join("\n");
            expect(text).toContain("Root, while nobody watched.");
            expect(text).toContain("Root replied again.");
            expect(text).not.toContain("Other, while nobody watched.");
            expect(text).not.toContain("The other chat replied.");
            expect(text).not.toContain("Root replied first.");
        } finally {
            resumed.close();
        }
        expect(gym.inference.unscripted).toEqual([]);
    });
});
