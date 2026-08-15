import { describe, expect, it } from "vitest";

import { moduleDatabase } from "../support/moduleDatabase.js";
import { SlotsModule } from "../../sources/slots/SlotsModule.js";
import { SLOTS_MIGRATION_KEY, slotsMigrations } from "../../sources/slots/SlotDatabase.js";

describe("SlotsModule", () => {
    const options = () => {
        let id = 0;
        let eventId = 0;
        return {
            scopeResolver: async () => true,
            publisher: async () => undefined,
            idFactory: () => `slot-${++id}`,
            eventIdFactory: () => `event-${++eventId}`,
            clock: () => 123,
        };
    };

    it("owns a stable migration and persists entries in the Agent Base database", async () => {
        const database = moduleDatabase(slotsMigrations, "slots-test");
        await database.ready;
        try {
            expect(slotsMigrations.map(([key]) => key)).toEqual([SLOTS_MIGRATION_KEY]);
            const module = new SlotsModule(options());
            const created = await module.create(database.context, "agent-a", {
                slot: "status-line",
                scope: "everywhere",
                content: { type: "text", markdown: "ready" },
                description: "A status",
                purpose: "Show readiness",
            });

            expect(created).toMatchObject({
                id: "slot-1",
                authorAgentId: "agent-a",
                slot: "status-line",
                scope: "everywhere",
                content: { type: "text", markdown: "ready" },
            });
            expect(await module.get(database.context, "agent-a", "slot-1")).toEqual(created);

            await module.create(database.context, "agent-a", {
                id: "slot-2",
                slot: "sidebar",
                scope: "everywhere",
                content: { type: "text", markdown: "second" },
                description: "Another status",
                purpose: "Exercise ordering",
            });
            await expect(module.remove(database.context, "agent-a", "slot-1")).resolves.toBe(true);
            const third = await module.create(database.context, "agent-a", {
                id: "slot-3",
                slot: "sidebar",
                scope: "everywhere",
                content: { type: "text", markdown: "third" },
                description: "A third status",
                purpose: "Exercise ordering",
            });

            const restarted = new SlotsModule(options());
            expect(await restarted.list(database.context, "agent-a")).toEqual([
                expect.objectContaining({ id: "slot-2", ordering: 0 }),
                expect.objectContaining({ ...third, ordering: 1 }),
            ]);
        } finally {
            database.close();
        }
    });

    it("rejects injected persistence options", () => {
        expect(
            () =>
                new SlotsModule({
                    ...options(),
                    transaction: async () => undefined,
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new SlotsModule({
                    ...options(),
                    store: {},
                } as never),
        ).toThrow("options are invalid");
    });
});
