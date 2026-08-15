import { describe, expect, it } from "vitest";

import { moduleDatabase } from "../support/moduleDatabase.js";
import { SlotsModule } from "../../sources/slots/SlotsModule.js";
import {
    SLOTS_IDEMPOTENCY_REMOVAL_MIGRATION_KEY,
    SLOTS_MIGRATION_KEY,
    slotsMigrations,
} from "../../sources/slots/SlotDatabase.js";

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
            expect(slotsMigrations.map(([key]) => key)).toEqual([
                SLOTS_MIGRATION_KEY,
                SLOTS_IDEMPOTENCY_REMOVAL_MIGRATION_KEY,
            ]);
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

    it("uses Agent Base transactional tools and the call ID without committing manually", async () => {
        const database = moduleDatabase(slotsMigrations, "slots-tool-commit-test");
        await database.ready;
        const module = new SlotsModule(options());
        const call = (id: string) =>
            ({
                id,
                providerCallId: `provider-${id}`,
                kv: {},
                commit: async () => {
                    throw new Error("Slots tools must not commit manually.");
                },
            }) as never;

        try {
            const tools = module.tools(database.context, { agent: { id: "agent-a" } } as Parameters<
                SlotsModule["tools"]
            >[1]);
            const execute = (name: string) => {
                const tool = tools.find((candidate) => candidate.name === name);
                if (tool?.execute === undefined) throw new Error(`Missing tool ${name}`);
                expect(tool.transactional).toBe(true);
                return tool.execute as (
                    ctx: typeof database.context,
                    input: never,
                    call: never,
                ) => Promise<unknown>;
            };

            await expect(
                execute("create_slot")(
                    database.context,
                    {
                        slot: "status-line",
                        scope: "everywhere",
                        content: { type: "text", markdown: "ready" },
                        description: "A status",
                        purpose: "Show readiness",
                    } as never,
                    call("create-call"),
                ),
            ).resolves.toEqual({
                entry: expect.objectContaining({ id: "create-call" }),
            });
            await expect(
                execute("update_slot")(
                    database.context,
                    { id: "create-call", purpose: "Show current readiness" } as never,
                    call("update-call"),
                ),
            ).resolves.toEqual({
                entry: expect.objectContaining({
                    id: "create-call",
                    purpose: "Show current readiness",
                }),
            });
            await expect(
                execute("reorder_slots")(
                    database.context,
                    { entryIds: ["create-call"] } as never,
                    call("reorder-call"),
                ),
            ).resolves.toEqual(
                expect.objectContaining({
                    entries: [expect.objectContaining({ id: "create-call" })],
                }),
            );
            await expect(
                execute("remove_slot")(
                    database.context,
                    { id: "create-call" } as never,
                    call("remove-call"),
                ),
            ).resolves.toEqual({ removed: true });
        } finally {
            database.close();
        }
    });

    it("rolls back direct mutations when transactional observation fails", async () => {
        const database = moduleDatabase(slotsMigrations, "slots-rollback-test");
        await database.ready;
        const module = new SlotsModule({
            ...options(),
            listener: {
                onEventTransactional: async () => {
                    throw new Error("reject mutation");
                },
            },
        });

        try {
            await expect(
                module.create(database.context, "agent-a", {
                    id: "rolled-back-slot",
                    slot: "status-line",
                    scope: "everywhere",
                    content: { type: "text", markdown: "not committed" },
                    description: "A rejected status",
                    purpose: "Exercise transaction rollback",
                }),
            ).rejects.toThrow("reject mutation");
            await expect(
                module.get(database.context, "agent-a", "rolled-back-slot"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("rejects injected transaction and store options", () => {
        expect(
            () =>
                new SlotsModule({
                    publisher: async () => undefined,
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new SlotsModule({
                    scopeResolver: async () => true,
                    publisher: async () => undefined,
                    transaction: async () => undefined,
                } as never),
        ).toThrow("options are invalid");
        expect(
            () =>
                new SlotsModule({
                    scopeResolver: async () => true,
                    publisher: async () => undefined,
                    store: {},
                } as never),
        ).toThrow("options are invalid");
    });
});
