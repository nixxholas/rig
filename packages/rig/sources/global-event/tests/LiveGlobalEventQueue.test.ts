import { describe, expect, it } from "vitest";

import type { GlobalEvent } from "../../protocol/index.js";
import { LIVE_GLOBAL_EVENT_GAP, LiveGlobalEventQueue } from "../LiveGlobalEventQueue.js";

function sessionEvent(sessionId: string, type = "session_status_changed"): GlobalEvent {
    return {
        createdAt: 1,
        data: {},
        id: `event-${sessionId}`,
        sessionId,
        type,
    } as unknown as GlobalEvent;
}

describe("LiveGlobalEventQueue", () => {
    it("orders every source on one strictly increasing cursor", () => {
        const queue = new LiveGlobalEventQueue();
        const cursors = [
            queue.publish(sessionEvent("a")).cursor,
            queue.publish(sessionEvent("b")).cursor,
            queue.publish(sessionEvent("a")).cursor,
        ];

        expect([...cursors].sort()).toEqual(cursors);
        expect(new Set(cursors).size).toBe(3);
        expect(queue.cursor()).toBe(cursors.at(-1));
    });

    it("serves a reconnect only the events it missed", () => {
        const queue = new LiveGlobalEventQueue();
        const first = queue.publish(sessionEvent("a")).cursor;
        queue.publish(sessionEvent("b"));
        queue.publish(sessionEvent("c"));

        const missed = queue.since(first);
        expect(missed).not.toBe(LIVE_GLOBAL_EVENT_GAP);
        expect(
            (missed as readonly { event: GlobalEvent }[]).map(
                (entry) => (entry.event as { sessionId: string }).sessionId,
            ),
        ).toEqual(["b", "c"]);
    });

    it("treats a client already at the head as caught up, not as a gap", () => {
        const queue = new LiveGlobalEventQueue();
        expect(queue.since(queue.cursor())).toEqual([]);
        queue.publish(sessionEvent("a"));
        expect(queue.since(queue.cursor())).toEqual([]);
    });

    it("reports a gap once the cursor has aged out of the window", () => {
        const queue = new LiveGlobalEventQueue({ capacity: 2 });
        const stale = queue.publish(sessionEvent("a")).cursor;
        queue.publish(sessionEvent("b"));
        queue.publish(sessionEvent("c"));
        queue.publish(sessionEvent("d"));

        expect(queue.since(stale)).toBe(LIVE_GLOBAL_EVENT_GAP);
    });

    it("reports a gap for a cursor it never issued", () => {
        const queue = new LiveGlobalEventQueue();
        queue.publish(sessionEvent("a"));

        expect(queue.since("ffffffff-ffff-7fff-bfff-ffffffffffff")).toBe(LIVE_GLOBAL_EVENT_GAP);
        expect(queue.since("00000000-0000-7000-8000-000000000000")).toBe(LIVE_GLOBAL_EVENT_GAP);
    });

    it("keeps delivering after one subscriber throws", () => {
        const queue = new LiveGlobalEventQueue();
        const seen: string[] = [];
        queue.subscribe(() => {
            throw new Error("this subscriber is broken");
        });
        queue.subscribe((entry) => seen.push((entry.event as { sessionId: string }).sessionId));

        queue.publish(sessionEvent("a"));
        expect(seen).toEqual(["a"]);
    });

    it("releases subscribers when the queue closes", () => {
        const queue = new LiveGlobalEventQueue();
        let closed = 0;
        queue.subscribe(
            () => undefined,
            () => (closed += 1),
        );
        queue.close();

        expect(closed).toBe(1);
        queue.publish(sessionEvent("a"));
        expect(closed).toBe(1);
    });
});
