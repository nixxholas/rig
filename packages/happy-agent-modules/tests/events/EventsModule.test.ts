import { describe, expect, it } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("EventsModule", () => {
    it("owns its journal migrations and reloads durable events", async () => {
        const first = new EventsModule({ now: () => 100 });
        const database = moduleDatabase(first.migrations ?? [], "events-restart-test");
        await database.ready;
        try {
            await first.beforeStart?.(database.context);
            const recorded = await first.record(database.context, {
                agentId: "agent-1",
                payload: { value: "durable" },
                type: "test.recorded",
            });

            expect(first.latestCursor("agent-1")).toBe(recorded.id);
            expect(first.replay(first.originCursor())?.events).toEqual([recorded]);

            const restarted = new EventsModule({ now: () => 50 });
            await restarted.beforeStart?.(database.context);

            expect(restarted.cursor()).toBe(recorded.id);
            expect(restarted.latestCursor("agent-1")).toBe(recorded.id);
            expect(restarted.replay(restarted.originCursor())?.events).toEqual([recorded]);
        } finally {
            database.close();
        }
    });

    it("finds accepted-message cursors and trims an exact durable prefix", async () => {
        const events = new EventsModule({ now: () => 200 });
        const database = moduleDatabase(events.migrations ?? [], "events-trim-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const accepted = await events.record(database.context, {
                agentId: "agent-1",
                payload: { id: "message-1" },
                type: "message.accepted",
            });
            const retained = await events.record(database.context, {
                agentId: "agent-1",
                payload: {},
                type: "test.retained",
            });

            expect(events.messageCursor("agent-1", "message-1")).toBe(accepted.id);
            await expect(events.trim(database.context, accepted.id)).resolves.toEqual({
                through: accepted.id,
                trimmed: 1,
            });
            expect(events.originCursor()).toBe(accepted.id);
            expect(events.replay(accepted.id)?.events).toEqual([retained]);
        } finally {
            database.close();
        }
    });
});
