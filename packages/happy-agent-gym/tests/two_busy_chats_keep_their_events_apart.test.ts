import type { SessionMessage } from "@slopus/happy-providers";
import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * Answers every run with the question it was just asked.
 *
 * Two chats working at once reach the model in whichever order they get there, so the answer has
 * to come from the request rather than from a position in a fixed list.
 */
function echoTheQuestion(request: GymInferenceRequest): GymTurn {
    const asked = request.messages.findLast(
        (message): message is Extract<SessionMessage, { readonly role: "user" }> =>
            message.role === "user",
    );
    const question = (asked?.content ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    return { content: [{ text: `Answered: ${question}`, type: "text" }] };
}

/** The run every projected event names, for the events that belong to one. */
function projectedRunIds(events: readonly Record<string, unknown>[]): readonly string[] {
    return events.flatMap((event) => {
        const data = event.data;
        if (data === null || typeof data !== "object") return [];
        const runId = (data as { readonly runId?: unknown }).runId;
        return typeof runId === "string" ? [runId] : [];
    });
}

describe("two chats working at the same time", () => {
    it("each read back only their own events from the one shared journal", async () => {
        const gym = await createAgentGym({ inference: echoTheQuestion, timeoutMs: 20_000 });
        running.add(gym);
        const other = await gym.createSession();

        const [rootRun, otherRun] = await Promise.all([
            gym.send("Root work.", { wait: false }),
            gym.send("Other work.", { sessionId: other.id, wait: false }),
        ]);
        await Promise.all([gym.waitForRun(rootRun.runId), gym.waitForRun(otherRun.runId)]);

        const rootEvents = await gym.sessionEvents();
        const otherEvents = await gym.sessionEvents(other.id);
        const rootText = JSON.stringify(rootEvents);
        const otherText = JSON.stringify(otherEvents);

        expect(rootText).toContain("Root work.");
        expect(rootText).toContain("Answered: Root work.");
        expect(rootText).not.toContain("Other work.");
        expect(otherText).toContain("Other work.");
        expect(otherText).toContain("Answered: Other work.");
        expect(otherText).not.toContain("Root work.");

        // Neither chat carries a single row belonging to the other chat's run.
        expect(projectedRunIds(rootEvents)).toContain(rootRun.runId);
        expect(projectedRunIds(rootEvents)).not.toContain(otherRun.runId);
        expect(projectedRunIds(otherEvents)).toContain(otherRun.runId);
        expect(projectedRunIds(otherEvents)).not.toContain(rootRun.runId);

        for (const [events, runId] of [
            [rootEvents, rootRun.runId],
            [otherEvents, otherRun.runId],
        ] as const) {
            const own = events.filter((event) => projectedRunIds([event])[0] === runId);
            expect(own.filter((event) => event.type === "message_submitted")).toHaveLength(1);
            expect(own.filter((event) => event.type === "run_finished")).toHaveLength(1);
        }

        // Both runs really did land in the same journal, under two different agents.
        const settled = (await gym.events()).filter(
            (event) =>
                event.type === "loop.settled" &&
                (runIdOf(event) === rootRun.runId || runIdOf(event) === otherRun.runId),
        );
        expect(settled).toHaveLength(2);
        expect(new Set(settled.map((event) => event.agentId)).size).toBe(2);
        expect(gym.errors).toEqual([]);
    });
});
