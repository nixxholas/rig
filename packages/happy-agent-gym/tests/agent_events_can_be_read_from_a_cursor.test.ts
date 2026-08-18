import type { AgentEvent } from "@slopus/happy-agent-modules";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, runIdOf, type AgentGym } from "../sources/index.js";

/** One answer from `GET /v0/events`, which is a slice of the journal plus where it ends. */
interface EventPage {
    readonly cursor: string;
    readonly events: readonly AgentEvent[];
    readonly latestCursor: string;
}

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

async function readEvents(gym: AgentGym, after: string, limit = 1_000): Promise<EventPage> {
    return await gym.http.ok<EventPage>(
        "GET",
        `/v0/events?after=${encodeURIComponent(after)}&limit=${String(limit)}`,
    );
}

describe("the durable event journal", () => {
    it("hands a client ordered ids it can page through without ever seeing one twice", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Paged answer.", type: "text" }] }],
        });
        running.add(gym);

        // A read with no cursor says where the journal is, and hands out nothing to catch up on.
        const head = await gym.http.ok<EventPage>("GET", "/v0/events");
        expect(head.events).toEqual([]);
        expect(head.cursor).toBe(head.latestCursor);

        await gym.send("Page through this.");

        const whole = await readEvents(gym, head.cursor);
        const ids = whole.events.map((event) => event.id);
        expect(ids.length).toBeGreaterThan(4);
        expect(new Set(ids).size).toBe(ids.length);
        // Event ids are time-ordered, so their journal order is also their sorted order.
        expect([...ids].sort()).toEqual(ids);
        expect(whole.cursor).toBe(ids.at(-1));
        expect(JSON.stringify(whole.events)).toContain("Page through this.");
        expect(JSON.stringify(whole.events)).toContain("Paged answer.");

        const paged: string[] = [];
        let cursor = head.cursor;
        while (cursor !== whole.cursor) {
            const page = await readEvents(gym, cursor, 2);
            expect(page.events.length).toBeGreaterThan(0);
            expect(page.events.length).toBeLessThanOrEqual(2);
            expect(page.cursor).toBe(page.events.at(-1)?.id);
            paged.push(...page.events.map((event) => event.id));
            cursor = page.cursor;
        }
        expect(paged).toEqual(ids);
        expect(gym.errors).toEqual([]);
    });

    it("resumes at a cursor and returns only the work that happened after it", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "First answer.", type: "text" }] },
                { content: [{ text: "Second answer.", type: "text" }] },
            ],
        });
        running.add(gym);

        const head = await gym.http.ok<EventPage>("GET", "/v0/events");
        await gym.send("First question.");

        const first = await readEvents(gym, head.cursor);
        expect(JSON.stringify(first.events)).toContain("First question.");
        expect(JSON.stringify(first.events)).toContain("First answer.");

        await gym.send("Second question.");

        const second = await readEvents(gym, first.cursor);
        const alreadySeen = new Set(first.events.map((event) => event.id));
        expect(second.events.filter((event) => alreadySeen.has(event.id))).toEqual([]);
        const secondText = JSON.stringify(second.events);
        expect(secondText).toContain("Second question.");
        expect(secondText).toContain("Second answer.");
        expect(secondText).not.toContain("First answer.");

        // The two reads are the journal split in two, with nothing lost and nothing repeated.
        const resumedIds = [
            ...first.events.map((event) => event.id),
            ...second.events.map((event) => event.id),
        ];
        const whole = await readEvents(gym, head.cursor);
        expect(whole.events.slice(0, resumedIds.length).map((event) => event.id)).toEqual(
            resumedIds,
        );
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("keeps everything after a trim readable and reports the trim point as its origin", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "First answer.", type: "text" }] },
                { content: [{ text: "Second answer.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("First question.");
        const secondRun = await gym.send("Second question.");

        // Trim everything the second run did not produce, which is the whole first turn.
        const before = await gym.events();
        const boundary = before.findIndex((event) => runIdOf(event) === secondRun.runId);
        expect(boundary).toBeGreaterThan(1);
        const through = before[boundary - 1]?.id ?? "";

        expect(await gym.http.ok("POST", "/v0/events/trim", { through })).toEqual({
            through,
            trimmed: boundary,
        });

        const survivors = before.slice(boundary).map((event) => event.id);
        const remaining = await readEvents(gym, through);
        expect(remaining.events.slice(0, survivors.length).map((event) => event.id)).toEqual(
            survivors,
        );
        expect(JSON.stringify(remaining.events)).toContain("Second answer.");
        expect(JSON.stringify(remaining.events)).not.toContain("First answer.");

        // The trim point became the journal's origin, so a cursor older than it is refused.
        expect(gym.modules.events.originCursor()).toBe(through);
        const stale = await gym.http.get<{ readonly cursor?: string }>(
            `/v0/events?after=${encodeURIComponent(before[0]?.id ?? "")}`,
        );
        expect(stale.status).toBe(409);
        expect(stale.text).toContain("Event cursor is unavailable.");
        // The refusal names a cursor the client can start again from.
        const restart = await gym.http.get(
            `/v0/events?after=${encodeURIComponent(stale.body.cursor ?? "")}`,
        );
        expect(restart.status).toBe(200);

        // Trimming through the origin again is a no-op rather than a failure.
        expect(await gym.http.ok("POST", "/v0/events/trim", { through })).toEqual({
            through,
            trimmed: 0,
        });

        // What the chat shows a client is the trimmed journal, not a second copy of the history.
        const projection = JSON.stringify(await gym.sessionEvents());
        expect(projection).toContain("Second answer.");
        expect(projection).not.toContain("First answer.");

        // The refused stale cursor is a modelled answer, not an unexpected daemon fault.
        expect(gym.errors).toEqual([]);
    });
});
