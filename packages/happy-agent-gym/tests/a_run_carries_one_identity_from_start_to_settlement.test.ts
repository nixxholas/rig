import type { AgentEvent } from "@slopus/happy-agent-modules";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, runIdOf, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** The loop an event was recorded under, which every run-bracketing event names. */
function loopIdOf(event: AgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const loopId = (payload as { readonly loopId?: unknown }).loopId;
    return typeof loopId === "string" ? loopId : undefined;
}

describe("a run's identity from its start to its settlement", () => {
    it("names one run in the start, the message it accepted, and the settlement", async () => {
        const gym = await createAgentGym({
            files: { "README.md": "fixture repository\n" },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "cat README.md" },
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                },
                { content: [{ text: "The readme describes a fixture.", type: "text" }] },
            ],
            permissionMode: "full_access",
        });
        running.add(gym);

        const acceptance = await gym.send("Read the readme.");
        const journal = await gym.events();
        const mine = journal.filter((event) => runIdOf(event) === acceptance.runId);
        const started = mine.filter((event) => event.type === "loop.started");
        const settled = mine.filter((event) => event.type === "loop.settled");

        // The run a client was handed is the one the journal opens and closes, exactly once each.
        expect(started).toHaveLength(1);
        expect(settled).toHaveLength(1);
        expect(loopIdOf(started[0] as AgentEvent)).toBe(loopIdOf(settled[0] as AgentEvent));

        // The message that made the run happen belongs to it, and arrives after it opened.
        const accepted = mine.filter((event) => event.type === "message.accepted");
        expect(accepted).toHaveLength(1);
        expect(accepted[0]?.payload).toMatchObject({ id: acceptance.id, kind: "send" });
        const order = mine.map((event) => event.type);
        expect(order[0]).toBe("loop.started");
        expect(order[1]).toBe("message.accepted");
        expect(order.at(-1)).toBe("loop.settled");

        // Everything the run did in between — two inferences and the tool call between them —
        // is under that same identity, so nothing it recorded belongs to a run of its own.
        expect(order).toContain("tool.started");
        expect(order).toContain("tool.completed");
        expect(order.filter((type) => type === "inference.completed")).toHaveLength(2);

        // No run in the journal is left hanging: every start has the settlement that answers it.
        const startedRuns = journal
            .filter((event) => event.type === "loop.started")
            .map((event) => runIdOf(event));
        const settledRuns = new Set(
            journal.filter((event) => event.type === "loop.settled").map((event) => runIdOf(event)),
        );
        expect(startedRuns.filter((runId) => !settledRuns.has(runId))).toEqual([]);

        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("gives the next run its own identity rather than reusing the one before it", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "First answer.", type: "text" }] },
                { content: [{ text: "Second answer.", type: "text" }] },
            ],
        });
        running.add(gym);

        const first = await gym.send("First question.");
        const second = await gym.send("Second question.");
        expect(second.runId).not.toBe(first.runId);

        const journal = await gym.events();
        for (const runId of [first.runId, second.runId]) {
            const bracketing = journal.filter(
                (event) =>
                    runIdOf(event) === runId &&
                    (event.type === "loop.started" || event.type === "loop.settled"),
            );
            expect(bracketing.map((event) => event.type)).toEqual(["loop.started", "loop.settled"]);
        }

        // The second run's whole journal comes after the first run settled, so a client reading
        // forward never sees one run's events inside the brackets of the other.
        const firstSettled = journal.findIndex(
            (event) => event.type === "loop.settled" && runIdOf(event) === first.runId,
        );
        const secondStarted = journal.findIndex(
            (event) => event.type === "loop.started" && runIdOf(event) === second.runId,
        );
        expect(firstSettled).toBeGreaterThan(0);
        expect(secondStarted).toBeGreaterThan(firstSettled);

        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
