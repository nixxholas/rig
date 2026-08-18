import type {
    EventStreamFrame,
    HappyAgentClient,
    HappyAgentEvent,
} from "@slopus/happy-agent-client";
import { describe, expect, it, vi } from "vitest";

import { HappyAgentEventHub } from "./HappyAgentEventHub.js";

const CURSOR_0 = "01900000-0000-7000-8000-000000000000";
const CURSOR_1 = "01900000-0000-7000-8000-000000000001";

describe("HappyAgentEventHub", () => {
    it("fans one SSE connection out to every ordered follower", async () => {
        const frames: EventStreamFrame[] = [
            {
                hello: { connectedAt: 1, cursor: CURSOR_0, gap: false, resumed: true },
                kind: "hello",
            },
            {
                cursor: CURSOR_1,
                event: event(CURSOR_1),
                kind: "event",
            },
        ];
        const streamEvents = vi.fn(async function* () {
            yield* frames;
        });
        const client = { streamEvents } as unknown as HappyAgentClient;
        const hub = new HappyAgentEventHub(client, CURSOR_0);
        const first: string[] = [];
        const second: string[] = [];

        await Promise.all([
            hub.follow({
                after: CURSOR_0,
                onEvent: (received) => {
                    first.push(received.cursor);
                    return true;
                },
            }),
            hub.follow({
                after: CURSOR_0,
                onEvent: (received) => {
                    second.push(received.cursor);
                    return true;
                },
            }),
        ]);
        await hub.close();

        expect(streamEvents).toHaveBeenCalledTimes(1);
        expect(first).toEqual([CURSOR_1]);
        expect(second).toEqual([CURSOR_1]);
    });
});

function event(cursor: string): HappyAgentEvent {
    return {
        cursor,
        occurredAt: 1,
        payload: {},
        type: "config.updated",
    };
}
